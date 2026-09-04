import type { TaskState } from "@solow/contracts";
import { STRANDED_REVIEW_REASON } from "@solow/core";
import { type Db, session, task } from "@solow/db";
import { and, desc, eq } from "drizzle-orm";
import type { AgentRegistry } from "../agent/registry.js";
import { orchestratorEnv } from "../env.js";
import { RECLAIM_STALE_MS, STRANDED_PARK_REASON } from "../reconcile.js";
import { CONTAINER_OWNER_PATH, deploymentId, ORCHESTRATOR_EPOCH } from "./docker.js";
import type { Executor } from "./types.js";

/**
 * The executor-container reaper (issue #96, spec F07).
 *
 * The last arm of the reconciliation sweep in `startWebSocketServer` — after, and deliberately not
 * alongside, the three sweeps that write verdicts onto Task rows, since this one reads those
 * verdicts — never a `setInterval` of its own and never a boot-only hook. Boot-only is precisely
 * the incident `RECONCILE_INTERVAL_MS`
 * documents: a run that died at 13:54 inside a process booted at 11:52 went unexamined for ninety
 * minutes. A container leaked at 13:54 holds its CPU reservation and its memory ceiling for just
 * as long, and unlike a stale Task row nobody can see it from the board.
 *
 * **The direction of inference is inverted from the sweeps beside it, and that is the trap.**
 * `reclaimOrphanedRuns` starts from database rows and asks "is this run still alive". This starts
 * from the *host* and asks "does this container still belong to something" — so the Task table,
 * the agent registry and the container's own claim (`ORCHESTRATOR_EPOCH`) are consulted as
 * **evidence of life**, never as a list of things to kill. A reaper that read them the other way
 * round would remove a container the moment a row was missing for any reason, including the ones
 * that have nothing to do with the container.
 *
 * The safety story is entirely the label pair `solow.managed` + `solow.deployment`. This machine
 * already runs unrelated containers — a reaper reasoning from names or images would eventually eat
 * one — and a reaper without the deployment label would eat a *different orchestrator's* live run
 * when a dev instance and a real one share a daemon.
 *
 * A deployment is one worktree root and therefore one process: two orchestrators started on the
 * *same* root share a deployment id, so each would read the other's claims as a crashed
 * predecessor's. They would already be fighting over the same worktrees, which is why that is
 * stated as an assumption rather than defended against — but it is the assumption the claim makes
 * load-bearing, and a rolling restart that leaves both alive for a while is where it would show.
 */

/**
 * How old a container has to be before it is even considered.
 *
 * The same twenty seconds `index.ts` waits before its first sweep, and for the same reason: a
 * container that has just been created may belong to a run that has not registered yet. Stated
 * here rather than imported because `index.ts` is what imports *this* module — reaching back for
 * its constant would be a cycle — and the value is the one thing about it that is not derived.
 */
export const REAP_GRACE_MS = 20_000;

/**
 * The Task states a run can still be sitting inside.
 *
 * `running` is the obvious one. `review` is a run parked in `waitForEvent("review.decided")` that
 * will loop round and use the same container for the next round, and `parked` is a run inside a
 * five-hour `step.sleepUntil` waiting for a quota window. Removing a container in either of those
 * would tear down a workspace a live run is coming back to.
 *
 * Everything else means no *verdict* says a run is holding this container — including `ready` and
 * `failed`, where `reclaimOrphanedRuns` leaves a Task whose run it has just declared gone. A
 * verdict is not a fact: that sweep reads silence, and an `executor-preflight` long enough to
 * matter produces exactly the silence it reads as death. So a state off this list makes a
 * container reapable, never reapable *now* — filter 3 waits a quiet window out from the row's own
 * last write however terminal that row reads, which is the correction that stopped a live run's
 * container being removed in the same sweep pass that condemned it.
 *
 * **A state on this list is never evidence of a live run by itself.** Nothing moves a Task out of
 * `review` or `parked` on its own — `reclaimOrphanedRuns` reads only `running` rows — so the
 * state says a run *was* here and nothing more. It is exactly as true of an orchestrator that
 * crashed two hours ago, and of a live orchestrator whose durable run went missing, as it is of
 * one holding the gate right now. Those are two different failures with two different tells, and
 * `heldByRun` and `claimedByThisOrchestrator` are the two that read them.
 */
const RUN_MAY_HOLD: readonly TaskState[] = ["running", "review", "parked"];

/**
 * Hosts whose `docker` binary is not there.
 *
 * Latched after the first ENOENT so a Docker-less deployment does not pay for a failed spawn
 * every sixty seconds for the life of the process. Keyed on the host `Executor` rather than kept
 * in a module-level flag so the latch has the lifetime of the thing it describes — a global would
 * outlive a test's fake host and quietly disable the next one.
 */
const noDockerBinary = new WeakSet<Executor>();

/** One container, as `docker ps --format` reported it. */
interface ManagedContainer {
  name: string;
  workspaceId: string;
  taskId: string;
  runId: string;
  createdAt: number | null;
}

export async function reapOrphanedContainers(
  host: Executor,
  db: Db,
  registry: Pick<AgentRegistry, "get">,
  now: () => Date = () => new Date(),
): Promise<number> {
  if (noDockerBinary.has(host)) return 0;

  const env = orchestratorEnv();
  const deployment = deploymentId(env.SOLOW_WORKTREE_ROOT);

  let listed: { stdout: string; exitCode: number };
  try {
    listed = await host.exec([
      env.SOLOW_DOCKER_BIN,
      "ps",
      "-a",
      "--filter",
      "label=solow.managed=true",
      "--filter",
      "label=solow.role=session",
      "--filter",
      `label=solow.deployment=${deployment}`,
      "--format",
      '{{.Names}}\t{{.Label "solow.workspace"}}\t{{.Label "solow.task"}}\t{{.Label "solow.run"}}\t{{.CreatedAt}}',
    ]);
  } catch (cause) {
    // Resolved, never thrown, and this is the whole reason: the sweep catches this arm and logs
    // without rethrowing, so an arm that rejected on a host with no Docker would print
    // "reconciliation sweep failed" every sixty seconds for ever and drown the signal the sweep
    // exists to carry.
    if (isMissingBinary(cause)) noDockerBinary.add(host);
    return 0;
  }
  // A daemon that is down is not an error either: nothing is leaking that a later sweep cannot
  // find, and there is nothing an operator could do with the message that they would not already
  // know from everything else being broken.
  if (listed.exitCode !== 0) return 0;

  const at = now().getTime();
  let removed = 0;

  for (const container of parseContainers(listed.stdout)) {
    // 1. Grace. A container younger than this may belong to a run that has not registered yet,
    //    and an unparseable creation time is treated as "too young to judge".
    if (container.createdAt === null || at - container.createdAt < REAP_GRACE_MS) continue;

    // 2. The registry, which is conclusive when it answers. Registration spans the whole
    //    `agent-run` step, so a container holding a twenty-minute build is always present here —
    //    and removing one that is would be the worst outcome available to this function.
    if (registry.get(container.workspaceId, container.taskId)) continue;

    const [row] = await db
      .select({
        state: task.state,
        failureReason: task.failureReason,
        updatedAt: task.updatedAt,
      })
      .from(task)
      .where(and(eq(task.workspaceId, container.workspaceId), eq(task.id, container.taskId)))
      .limit(1);

    // What the Task table has to say about whether anything is still in here, asked once because
    // both filters below turn on it — and answered by `heldByRun` rather than by a state test
    // written out twice, which is how the two came to disagree.
    const held = row !== undefined && heldByRun(row);

    // 3. Quiet. The registry is empty in every gap *between* durable steps, and a live run spends
    //    a good deal of its time in one: the moment after `agent-run` returns and before
    //    `to-review` commits, the whole of `executor-preflight` (which is where the daemon
    //    handshake, the pull and the prepare script actually happen — see the step's own comment
    //    in task-run.ts), and, on a run woken from a park, the one gap between the sleep returning
    //    and the next agent starting. So a Task whose row was written recently is left alone until
    //    it has also gone silent for long enough that no ordinary gap explains it.
    //
    //    **The cushion is measured from the row's own last write and asks nothing about its
    //    state**, and that breadth is the correction rather than sloppiness. It used to apply only
    //    to a state a run could still be sitting inside, which meant the reaper acted on a verdict
    //    in the same millisecond another sweep wrote it — twice over. A freshly stamped `parked`
    //    row went straight past with only the twenty-second creation grace behind it, leaving the
    //    stamp as the sole thing between a live sleeper's container and `docker rm -f`. And an
    //    `executor-preflight` longer than `RECLAIM_STALE_MS` is silent by construction — no
    //    registry entry, no session event, nothing but an image pull — so `reclaimOrphanedRuns`
    //    files the live run as `interrupted`, `held` goes false on the `failed` row it writes, and
    //    the container was torn down in the same pass. Reproduced on Docker 29.7.2 against the
    //    real `reconcileSweep` with a real container — one `running` Task, empty registry, no
    //    session events, a container past the creation grace carrying this process's own epoch:
    //    one call left `STATE: failed REASON: interrupted` and the container gone.
    //
    //    **This buys the run one more window, not cover, and the difference is worth saying
    //    plainly.** A preflight quiet for longer than `2 × RECLAIM_STALE_MS` is condemned and torn
    //    down exactly as before; and even inside the window nothing here takes back the `failed`
    //    the reclaim sweep wrote, so the operator still sees a Task that died while its run was
    //    alive. The only thing that closes either is the run lifecycle publishing a container's
    //    existence before an agent exists to own it — the registration `heldByRun` names below —
    //    which is a change to the lifecycle and not to a reaper.
    //
    //    What removal costs when it is wrong is worth stating plainly, because it is not always
    //    "a rebuilt container": verified on Docker 29.7.2 that `docker rm -f` on a container with
    //    a running exec kills that exec with 137, and `ensureContainer` turns a prepare script
    //    killed that way into an `ExecutorUnavailableError` that fails the round.
    if (row !== undefined && at - Date.parse(row.updatedAt) < RECLAIM_STALE_MS) continue;

    // 4. Remove only what survives all three, and only for a stated reason: nothing in the Task
    //    table is holding it (`heldByRun` — no row, a state no run sits inside, or a run this
    //    orchestrator's own reconciler has already declared gone), the container was left behind
    //    by a *previous* run of this Task, or no orchestrator that is still alive has it.
    //
    //    The last one is asked last because it is the only one that costs a round trip, and
    //    because the two before it are cheaper ways of reaching the same "nothing is holding
    //    this" — `||` never asks it for a container already condemned.
    const orphaned =
      !held ||
      container.runId !== (await currentSessionId(db, container.workspaceId, container.taskId)) ||
      !(await claimedByThisOrchestrator(host, env.SOLOW_DOCKER_BIN, container.name));
    if (!orphaned) continue;

    const result = await host.exec([env.SOLOW_DOCKER_BIN, "rm", "-f", container.name]);
    if (result.exitCode === 0) removed += 1;
  }

  return removed;
}

/**
 * Whether the Task row still describes a run that could be holding this container.
 *
 * The state is half the row, and reading only that half is what leaked a container for the life
 * of a *live* process. `reportStrandedReviews` is this codebase's answer to "the durable engine
 * lost a run while the orchestrator carried on" — the run parked in `waitForEvent` is gone, the
 * operator's decision was recorded and nothing applied it — and it records that answer here, on
 * the Task, deliberately leaving the state at `review` so the diff and the decision stay
 * readable. So `review` + `STRANDED_REVIEW_REASON` is the reconciler saying, in the one place
 * both sweeps can see, that no run is in there.
 *
 * The reaper takes that verdict rather than reaching a second one. Asking the container instead
 * answers a different question — `claimedByThisOrchestrator` says which *process* created it, and
 * a process that has lost a run is still the process that created it — so a stranded Task's
 * container carried this epoch, `orphaned` came out false on every pass, and nothing else ever
 * removes it (`reclaimOrphanedRuns` selects only `running` rows). Verified on Docker 29.7.2:
 * `reportStrandedReviews` returned 1 on the same tick the reaper returned 0 and `docker inspect`
 * still said `running`.
 *
 * `parked` is the same shape of failure with the same shape of answer. A run asleep in
 * `step.sleepUntil` has no process and no registry entry either, so before it had a tell of its
 * own the arithmetic above came out `orphaned === false` on every sweep for the life of the
 * process — this time with nothing anywhere to correct it, since `reportStrandedReviews` looks
 * only at `review` rows and a sleeping run has no decision to strand. `reportStrandedParks` is
 * the reconciler saying the same sentence about a run that slept through its own wake-up, on the
 * same terms and in the same column, and this reads that verdict rather than reaching a second
 * one from the clock. What separates a lost sleeper from one still inside its quota window is
 * stated there, next to the sweep that has to be careful about it. Verified on Docker 29.7.2 the
 * same way the review case was: one real container labelled for a `parked` Task, carrying this
 * process's epoch and the newest Session's id, survived a sweep that returned 0 and was removed
 * by the next one after `reportStrandedParks` had spoken.
 *
 * Paired with the state rather than read on its own, because the review reason is not cleared when
 * a late redrive resumes the Task for another round: an agent working inside that container must
 * not be reaped on the strength of a verdict that has been overtaken. For `review` the pairing is
 * complete cover, and for a reason worth stating — the resume path moves the Task to `running`
 * (`resume-` in task-run.ts), where this function is unconditionally true, so the stamp becomes
 * unreadable here the moment the run acts on the decision it was said to have lost.
 *
 * **A `parked` row is never moved by its own run, so the same pairing is not the same cover.** A
 * woken run does its next round with the row still reading `parked` throughout, and nothing in the
 * orchestrator used to clear `failureReason` for a parked Task — so an overtaken stamp stayed
 * readable here across every gap between durable steps, for as long as it took an operator to move
 * the card. That is the asymmetry: for `review` the state moves and the stamp stops being read;
 * for `parked` the state never moves and only the reason can be taken back.
 *
 * Two things now close it, neither of them this function: the park step clears the reason the
 * moment its sleep returns, *before* the round it wakes into reaches an executor, so a stamp
 * cannot outlive the sleep it describes; and filter 3 above measures its quiet window from the
 * row's own last write and not from what the row says, so a Task this sweep has just condemned
 * still gets ten minutes in which a late wake-up can show a sign of life.
 *
 * **What the registry does and does not cover here, stated exactly, because the first draft of
 * this comment got it backwards.** `deps.registry.register` is reached on the same synchronous
 * tick as `runner.start` — there is no `await` between them in task-run.ts, and `start` returns a
 * handle rather than awaiting anything — so a container built lazily by the agent's own first
 * `spawn` is registered long before any `docker` call it triggered can return. The window filter 2
 * genuinely cannot see is the other one: `executor-preflight` is a durable step of its own, before
 * the round loop, and it is where a container is created and prepared with no agent registered at
 * all.
 *
 * The residual risk, then, is any verdict that has been stale for more than `RECLAIM_STALE_MS`
 * while a container of its own is live: a wake-up whose clearing write never lands because the
 * process died between the sleep returning and the step committing, and — the commoner one — an
 * `executor-preflight` that outlasts two quiet windows, where `reclaimOrphanedRuns` writes
 * `failed` over a run that is still pulling an image and this function then reads it as empty.
 * Nothing here can see into either window; a container is only ever as alive as the last thing
 * that wrote about it. Closing them properly means the run lifecycle publishing a container's
 * existence before an agent exists to own it — a second kind of registry entry, since today's is
 * built around an `AgentHandle` that `executor-preflight` does not have — which is a change to the
 * run lifecycle and not to a reaper.
 */
function heldByRun(row: { state: TaskState; failureReason: string | null }): boolean {
  if (!RUN_MAY_HOLD.includes(row.state)) return false;
  if (row.state === "review") return row.failureReason !== STRANDED_REVIEW_REASON;
  if (row.state === "parked") return row.failureReason !== STRANDED_PARK_REASON;
  return true;
}

/**
 * Whether the container is still in the hands of *this* orchestrator process.
 *
 * `ensureContainer` writes this process's epoch into the container's own tmpfs every time it
 * creates or adopts one, so the answer is no for a container the previous, crashed process left
 * behind — the one case neither the Task table nor `heldByRun` can describe, because a run
 * suspended at the review gate has no process and no registry entry even while it is perfectly
 * alive.
 *
 * Any failure is a no: the exec fails when the container has stopped, when the file was never
 * written, and when the daemon has gone — none of which is a live run holding a workspace, and
 * all of which end with the reaper's own `docker rm -f` deciding whether the container was there.
 */
async function claimedByThisOrchestrator(
  host: Executor,
  bin: string,
  name: string,
): Promise<boolean> {
  const claim = await host.exec([bin, "exec", name, "cat", CONTAINER_OWNER_PATH]);
  return claim.exitCode === 0 && claim.stdout.trim() === ORCHESTRATOR_EPOCH;
}

/** The newest Session for a Task — the run whose container this ought to be. */
async function currentSessionId(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<string | null> {
  const [newest] = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.workspaceId, workspaceId), eq(session.taskId, taskId)))
    .orderBy(desc(session.startedAt))
    .limit(1);
  return newest?.id ?? null;
}

/** Tab-separated `docker ps --format` output; a line that is not five fields is not ours. */
function parseContainers(stdout: string): ManagedContainer[] {
  const containers: ManagedContainer[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const [name, workspaceId, taskId, runId, createdAt] = line.split("\t");
    if (!name || !workspaceId || !taskId) continue;
    containers.push({
      name,
      workspaceId,
      taskId,
      runId: runId ?? "",
      createdAt: parseDockerTime(createdAt ?? ""),
    });
  }
  return containers;
}

/**
 * `{{.CreatedAt}}` is Go's own layout — `2026-09-03 10:24:59 +0200 CEST` — which `Date.parse`
 * answers `NaN` for. Reassembled into ISO-8601 rather than asked for a second time through
 * `docker inspect`: one enumeration call for the whole sweep beats one round trip per container.
 */
function parseDockerTime(value: string): number | null {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})/,
  );
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T${match[2]}${match[3]}:${match[4]}`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** ENOENT for the `docker` binary itself, however the host executor dressed it up. */
function isMissingBinary(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === "ENOENT") return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return /ENOENT|No such file or directory|executable file not found/i.test(message);
}
