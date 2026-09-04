import { beforeAll, describe, expect, it } from "bun:test";
import { INTERRUPTED_REASON } from "@solow/core";
import {
  agentCatalog,
  agentProfile,
  encryptSecret,
  executorProfile,
  issue,
  review,
  secret,
  session,
  task,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { setTaskState } from "../data.js";
import { orchestratorEnv } from "../env.js";
import { reconcileSweep } from "../index.js";
import {
  PARK_WINDOW_MS,
  RECLAIM_STALE_MS,
  reportStrandedParks,
  reportStrandedReviews,
  STRANDED_PARK_REASON,
} from "../reconcile.js";
import {
  CONTAINER_OWNER_PATH,
  createDockerExecutor,
  type DockerExecutorConfig,
  type DockerExecutorOpts,
  type DockerIds,
  deploymentId,
  ensureContainer,
  ORCHESTRATOR_EPOCH,
} from "./docker.js";
import { REAP_GRACE_MS, reapOrphanedContainers } from "./reap.js";
import type { ExecResult, Executor } from "./types.js";

/**
 * The executor-container reaper (issue #96, spec F07).
 *
 * **The direction of inference is what these cases are really about.** `reclaimOrphanedRuns`
 * starts from database rows and asks "is this run still alive"; this starts from the host and
 * asks "does this container still belong to something", so the Task table, the agent registry and
 * the container's own claim are read as *evidence of life* and never as a list of things to kill.
 * Almost every test below is therefore a **skip**: removing a container that a live agent is
 * working inside is the worst outcome available to this function, and it costs an operator a
 * twenty-minute build with no explanation anywhere they can see.
 *
 * The exceptions are the two ways a run goes missing while its Task still reads `review`, since a
 * Task row alone cannot tell either of them from a live run waiting at the gate — and reading it
 * as if it could is what leaked a container for ever. A *crashed* orchestrator is caught by the
 * container's own claim; a *live* orchestrator whose durable engine lost the run is caught only
 * by the reconciler's verdict on the Task, which is why that case drives the real
 * `reportStrandedReviews` instead of restating what it writes. Both are in the fourth describe,
 * and they are why the driver's own lifecycle invariants are pinned at the bottom of this file
 * rather than beside the driver.
 *
 * The clock moves rather than the rows being back-dated, exactly as `reconcile.test.ts` does. A
 * test that inserted a Task with a doctored `updatedAt` would be asserting against a row shape
 * the product never writes, and would keep passing if the staleness rule started reading a
 * different column.
 */

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
  // `orchestratorEnv()` is what the reaper reads its deployment identity and `docker` binary
  // from, and it refuses to parse without this.
  process.env.SOLOW_STREAM_SECRET ??= "test-stream-secret";
});

const WS = "ws-alpha";

/**
 * The clocks, both relative to now, because the rows under test carry a real `updatedAt`.
 *
 * `NOW` is a Task the sweep has caught in the ordinary gap between two durable steps; `STALE` is
 * the same Task ten minutes later, after the quiet window the reconciler owns has expired.
 */
const NOW = () => new Date();
const STALE = () => new Date(Date.now() + RECLAIM_STALE_MS * 2);

/**
 * And the clock a `parked` container has to be read against: past the whole quota window.
 *
 * `STALE` is twenty minutes, which is deep inside a five-hour sleep — a parked Task is *supposed*
 * to look untouched then, and the cases below need a clock that can tell "still asleep" from
 * "slept through its own wake-up" without back-dating any row.
 */
const AFTER_PARK_WINDOW = () => new Date(Date.now() + PARK_WINDOW_MS + RECLAIM_STALE_MS * 2);

/**
 * And the clock a verdict has to be read against while it is still young.
 *
 * Halfway through the quiet window the reconciler owns, measured from the moment the sweep wrote
 * its reason — the span in which a wake-up that ran late can still turn up and register.
 */
const SOON_AFTER = () => new Date(Date.now() + RECLAIM_STALE_MS / 2);

/** The `docker` binary and deployment hash the reaper will actually use — derived, never restated. */
function expectedDeployment(): string {
  return deploymentId(orchestratorEnv().SOLOW_WORKTREE_ROOT);
}

async function seedTask(
  db: TestDb,
  opts: { taskId: string; taskState?: "running" | "review" | "parked" | "done" | "failed" },
) {
  const [existing] = await db.select().from(workspace);
  if (!existing) {
    await db.insert(workspace).values({ id: WS, name: WS, ownerUserId: "u1" });
    await db.insert(secret).values({
      id: `sec-${WS}`,
      workspaceId: WS,
      name: "claude-token",
      kind: "subscription_token",
      ciphertext: encryptSecret("sk-ant-oat01-super-secret"),
    });
    await db.insert(agentCatalog).values({
      id: `cat-${WS}`,
      workspaceId: WS,
      key: "claude_code",
      displayName: "Claude Code",
      protocol: "claude_code_stream_json",
      command: "claude",
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
    });
    await db.insert(agentProfile).values({
      id: `ap-${WS}`,
      workspaceId: WS,
      name: "Default Claude",
      agentCatalogId: `cat-${WS}`,
      authMode: "subscription",
      secretId: `sec-${WS}`,
    });
    await db.insert(executorProfile).values({
      id: `ex-${WS}`,
      workspaceId: WS,
      name: "Docker",
      kind: "docker",
      config: { kind: "docker", image: "solow/agent:1", mounts: [], env: {} },
    });
    await db.insert(issue).values({ id: `iss-${WS}`, workspaceId: WS, title: "An issue" });
  }

  await db.insert(task).values({
    id: opts.taskId,
    workspaceId: WS,
    issueId: `iss-${WS}`,
    title: "A task",
    state: opts.taskState ?? "running",
    agentProfileId: `ap-${WS}`,
    executorProfileId: `ex-${WS}`,
  });
  const sessionId = `sess-${opts.taskId}`;
  await db.insert(session).values({ id: sessionId, workspaceId: WS, taskId: opts.taskId });
  return { sessionId };
}

/** A registry that reports nothing live, unless told otherwise — the after-a-restart case. */
function fakeRegistry(live: ReadonlySet<string> = new Set()) {
  return {
    get: (workspaceId: string, taskId: string) =>
      live.has(`${workspaceId}:${taskId}`)
        ? { taskId, sessionId: "sess-live", handle: {} as never }
        : undefined,
  };
}

/**
 * Somewhere for `reportStrandedReviews` to announce into.
 *
 * The reaper publishes nothing itself — a container is not a board card — so this exists only so
 * the *real* reconciler sweep can be driven from these cases rather than its conclusion retyped.
 */
function fakeHub() {
  return {
    publish: () => {},
    boardChannel: (workspaceId: string) => `board:${workspaceId}`,
    taskChannel: (workspaceId: string, taskId: string) => `task:${workspaceId}:${taskId}`,
  };
}

/**
 * `{{.CreatedAt}}` in Go's own layout, which is what the reaper has to parse.
 *
 * Written out rather than mocked away because `Date.parse` answers `NaN` for it, and an
 * unparseable time is treated as "too young to judge" — so a formatting change here would
 * silently turn every case below into a skip that still reported the number it expected.
 */
function dockerTime(at: Date): string {
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000 UTC`;
}

interface ContainerRow {
  name: string;
  taskId: string;
  runId: string;
  /** How long before "now" the daemon says it was created. Past `REAP_GRACE_MS` by default. */
  ageMs?: number;
  workspaceId?: string;
  /**
   * What `cat /run/solow/owner` finds inside the container.
   *
   * Defaulted to this process's own epoch, because that is what every container a live run holds
   * carries — `ensureContainer` writes it on creation and again on every adoption. `null` is the
   * container that has none: one a crashed orchestrator created before this process existed, or
   * one that has stopped, where the exec itself fails.
   */
  owner?: string | null;
}

function psLine(row: ContainerRow): string {
  const age = row.ageMs ?? REAP_GRACE_MS * 3;
  return [
    row.name,
    row.workspaceId ?? WS,
    row.taskId,
    row.runId,
    dockerTime(new Date(Date.now() - age)),
  ].join("\t");
}

function fakeHost(
  rows: ContainerRow[],
  onExec?: (cmd: string[]) => Partial<ExecResult> | undefined,
) {
  const calls: string[][] = [];
  const removed: string[] = [];
  const unused = () => {
    throw new Error("the reaper reaches the daemon through exec alone");
  };
  const executor: Executor = {
    async exec(cmd) {
      calls.push(cmd);
      const scripted = onExec?.(cmd);
      if (scripted) return { stdout: "", stderr: "", exitCode: 0, ...scripted };
      if (cmd[1] === "ps") {
        return { stdout: rows.map(psLine).join("\n"), stderr: "", exitCode: 0 };
      }
      if (cmd[1] === "exec" && cmd[3] === "cat") {
        const owner = rows.find((row) => row.name === cmd[2])?.owner;
        // A missing claim file and a container that has stopped fail the same way — non-zero,
        // with the diagnosis on stderr — which is why the reaper reads the exit code and not
        // just the text.
        if (owner === null) {
          return { stdout: "", stderr: `cat: can't open '${cmd[4]}'`, exitCode: 1 };
        }
        return { stdout: `${owner ?? ORCHESTRATOR_EPOCH}\n`, stderr: "", exitCode: 0 };
      }
      if (cmd[1] === "rm") {
        removed.push(cmd[cmd.length - 1] as string);
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    spawn: unused,
    baseEnv: unused,
    fs: { exists: unused, readFile: unused, writeFile: unused, list: unused, copy: unused },
    forward: unused,
    metrics: unused,
    async dispose() {},
  };
  return { executor, calls, removed };
}

describe("enumeration", () => {
  it("asks only for this deployment's own session containers", async () => {
    const db = createTestDb();
    const host = fakeHost([]);

    await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    // The `solow.managed` + `solow.deployment` pair is the entire safety story. This machine
    // already runs unrelated containers, so a reaper reasoning from names or images would
    // eventually eat one — and one without the deployment filter would eat a *different*
    // orchestrator's live run when a dev instance and a real one share a daemon.
    expect(host.calls[0]).toEqual([
      orchestratorEnv().SOLOW_DOCKER_BIN,
      "ps",
      "-a",
      "--filter",
      "label=solow.managed=true",
      "--filter",
      "label=solow.role=session",
      "--filter",
      `label=solow.deployment=${expectedDeployment()}`,
      "--format",
      '{{.Names}}\t{{.Label "solow.workspace"}}\t{{.Label "solow.task"}}\t{{.Label "solow.run"}}\t{{.CreatedAt}}',
    ]);
  });
});

describe("filter 1 — grace", () => {
  it("leaves a container younger than the grace period alone", async () => {
    const db = createTestDb();
    // No Task row at all, which is otherwise the clearest possible orphan: the container is
    // still spared, because a run that has not registered yet looks exactly like this.
    const host = fakeHost([
      { name: "solow-fresh", taskId: "task-unknown", runId: "sess-x", ageMs: 1_000 },
    ]);

    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), NOW);

    expect(count).toBe(0);
    expect(host.removed).toEqual([]);
  });

  it("treats a creation time it cannot parse as too young to judge", async () => {
    const db = createTestDb();
    const host = fakeHost([], () => ({ stdout: "solow-odd\tws-alpha\ttask-x\tsess-x\tyesterday" }));

    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(0);
  });
});

describe("filter 2 — the registry", () => {
  it("leaves a container alone while its agent is registered", async () => {
    const db = createTestDb();
    // Deliberately with no Task row and a stale clock, so the registry is the *only* thing
    // saving it. Registration spans the whole `agent-run` step, which is where a container
    // holding a twenty-minute build spends its time.
    const host = fakeHost([{ name: "solow-live", taskId: "task-live", runId: "sess-live" }]);

    const count = await reapOrphanedContainers(
      host.executor,
      db,
      fakeRegistry(new Set([`${WS}:task-live`])),
      STALE,
    );

    expect(count).toBe(0);
    expect(host.removed).toEqual([]);
  });
});

describe("filter 3 — quiet", () => {
  it("leaves a running Task's container alone in the gap between two durable steps", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-gap" });
    const host = fakeHost([{ name: "solow-gap", taskId: "task-gap", runId: sessionId }]);

    // The moment after `agent-run` returns and before `to-review` commits: nothing is
    // registered, and the run is milliseconds from carrying on. Reaping here would be the bug.
    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), NOW);

    expect(count).toBe(0);
    expect(host.removed).toEqual([]);
  });

  it("holds a container for a Task parked in review or waiting on quota", async () => {
    const db = createTestDb();
    const review = await seedTask(db, { taskId: "task-review", taskState: "review" });
    const parked = await seedTask(db, { taskId: "task-parked", taskState: "parked" });
    const host = fakeHost([
      { name: "solow-review", taskId: "task-review", runId: review.sessionId },
      { name: "solow-parked", taskId: "task-parked", runId: parked.sessionId },
    ]);

    // A run in `waitForEvent("review.decided")` comes back to the same container for the next
    // round, and one inside a five-hour `step.sleepUntil` is still holding its workspace. Both
    // outlive the quiet window by design, so the clock is moved past it here on purpose — and
    // both containers carry this process's claim, which is the half of the story that says the
    // orchestrator holding them is still there. The case below is the other half.
    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(0);
    expect(host.removed).toEqual([]);
  });

  it("gives a park it has just condemned the same quiet window as any other Task", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-late", taskState: "parked" });
    const host = fakeHost([
      // Thirty seconds old: past the creation grace, and exactly what a container looks like when
      // the run this sweep gave up on has in fact just woken and is inside its prepare script.
      { name: "solow-late", taskId: "task-late", runId: sessionId, ageMs: 30_000 },
    ]);
    expect(await reportStrandedParks(db, fakeRegistry(), fakeHub(), AFTER_PARK_WINDOW)).toBe(1);

    /*
     * The stamp is a verdict about a run, not a fact about a container, and for the first ten
     * minutes it is the *only* thing saying nothing is in there: `heldByRun` goes false the
     * instant it lands, which used to carry a stamped row straight past this filter with only the
     * twenty-second creation grace behind it.
     *
     * The registry is no help across the gaps, which is the whole reason this filter exists. On
     * this path there is exactly one gap and not several: after `park-woke-` the loop head runs
     * `agentBrief` and `briefWorkspaces`, both synchronous, and the next statement is `agent-run`,
     * which registers on the same tick as `runner.start`. The gap that matters is the other one —
     * the container's own create-and-prepare happens in `executor-preflight`, a durable step with
     * no agent in it at all. What removal costs there is not a rebuild: verified on Docker 29.7.2
     * that `docker rm -f` on a container with a running exec kills it with 137, which
     * `ensureContainer` reports as an `ExecutorUnavailableError` that fails the round.
     */
    expect(await reapOrphanedContainers(host.executor, db, fakeRegistry(), SOON_AFTER)).toBe(0);
    expect(host.removed).toEqual([]);

    // And the cushion is a cushion, not a reprieve: once no ordinary wake-up could still be
    // arriving, the container the tell exists to free is taken.
    expect(await reapOrphanedContainers(host.executor, db, fakeRegistry(), AFTER_PARK_WINDOW)).toBe(
      1,
    );
    expect(host.removed).toEqual(["solow-late"]);
  });
});

describe("filter 4 — what is actually orphaned", () => {
  it("removes a container whose labels decode to no Task at all", async () => {
    const db = createTestDb();
    const host = fakeHost([{ name: "solow-ghost", taskId: "task-deleted", runId: "sess-gone" }]);

    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(1);
    expect(host.removed).toEqual(["solow-ghost"]);
    expect(host.calls.at(-1)).toEqual([
      orchestratorEnv().SOLOW_DOCKER_BIN,
      "rm",
      "-f",
      "solow-ghost",
    ]);
  });

  it("removes a container for a Task in a state no run sits inside, a quiet window later", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-done", taskState: "done" });
    const host = fakeHost([{ name: "solow-done", taskId: "task-done", runId: sessionId }]);

    /*
     * The quiet window is measured from the row's own last write and asks nothing about the state,
     * so even a terminal Task serves it — which is not generosity towards `done` but the only
     * shape of rule that also covers the row next door. `reclaimOrphanedRuns` writes `failed` on a
     * `running` Task it has decided is gone, and it decides that from silence; an
     * `executor-preflight` long enough to matter is silent by construction. A cushion that skipped
     * states no run sits inside removed that container in the same sweep pass, with the run still
     * inside its prepare script.
     */
    expect(await reapOrphanedContainers(host.executor, db, fakeRegistry(), NOW)).toBe(0);
    expect(host.removed).toEqual([]);

    // And a cushion is not a reprieve: nothing is coming back to a `done` Task, so one window
    // later the machine gets its CPU reservation and memory ceiling back.
    expect(await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE)).toBe(1);
    expect(host.removed).toEqual(["solow-done"]);
  });

  it("removes a container left behind by a previous run of the same Task", async () => {
    const db = createTestDb();
    await seedTask(db, { taskId: "task-retry" });
    const host = fakeHost([
      { name: "solow-old-run", taskId: "task-retry", runId: "sess-a-previous-run" },
    ]);

    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(1);
    expect(host.removed).toEqual(["solow-old-run"]);
  });

  it("keeps the container belonging to the Task's current run, however quiet it has gone", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-slow" });
    const host = fakeHost([{ name: "solow-current", taskId: "task-slow", runId: sessionId }]);

    // Silence is not evidence: a `running` Task whose newest Session is the one this container
    // was labelled with is a run the reaper has no business ending. `reclaimOrphanedRuns` is the
    // sweep that decides such a run is over, and this one takes the container afterwards.
    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(0);
    expect(host.removed).toEqual([]);
  });

  it("counts only the removals the daemon actually performed", async () => {
    const db = createTestDb();
    const host = fakeHost(
      [
        { name: "solow-a", taskId: "task-a", runId: "sess-a" },
        { name: "solow-b", taskId: "task-b", runId: "sess-b" },
      ],
      (cmd) =>
        cmd[1] === "rm" && cmd[3] === "solow-b"
          ? { exitCode: 1, stderr: "Error response from daemon: removal in progress\n" }
          : undefined,
    );

    // `index.ts` logs this number to an operator. A count of intentions rather than removals
    // would report a tidy machine that still had the container on it.
    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(1);
  });

  it("removes a review or parked container the crashed orchestrator left behind", async () => {
    const db = createTestDb();
    const review = await seedTask(db, { taskId: "task-crash-review", taskState: "review" });
    const parked = await seedTask(db, { taskId: "task-crash-parked", taskState: "parked" });
    const host = fakeHost([
      // Claimed by a process that is not this one, and by one that never got to claim at all —
      // the two shapes a crash leaves behind.
      {
        name: "solow-was-in-review",
        taskId: "task-crash-review",
        runId: review.sessionId,
        owner: "a-dead-orchestrator",
      },
      {
        name: "solow-was-parked",
        taskId: "task-crash-parked",
        runId: parked.sessionId,
        owner: null,
      },
    ]);

    /*
     * Everything the reaper used to read says these are alive: the Task is in `review` or
     * `parked`, and the container's `solow.run` is the newest Session for it. Nothing ever moves
     * such a row on its own — `reclaimOrphanedRuns` reads only `running` Tasks and
     * `reportStrandedReviews` writes a `failureReason` and leaves the state — so before the claim
     * existed the sweep computed `orphaned === false` on every pass for ever, and the container
     * held its CPU reservation and memory ceiling until somebody noticed it by hand. This is the
     * DoD line issue #96 states in as many words: "a crashed orchestrator must not leave
     * containers holding CPU and disk".
     */
    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(2);
    expect(host.removed).toEqual(["solow-was-in-review", "solow-was-parked"]);
  });

  it("removes a review container whose run this still-live process lost", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-stranded", taskState: "review" });
    // The decision an operator recorded and nothing applied: the fact `reportStrandedReviews`
    // reads to conclude that the run parked in `waitForEvent("review.decided")` is gone.
    await db.insert(review).values({
      id: "rev-stranded",
      workspaceId: WS,
      sessionId,
      decision: "approve",
      actorUserId: "u1",
    });
    // Claimed by this process, because this process never crashed — `ensureContainer` wrote the
    // epoch and the orchestrator that wrote it is still here. Defaulted rather than spelled out,
    // so the case keeps meaning what it says if the claim's shape changes.
    const host = fakeHost([{ name: "solow-stranded", taskId: "task-stranded", runId: sessionId }]);

    /*
     * The reconciler's verdict, produced by the real sweep rather than a `failureReason` typed in
     * here — the point of the case is that the two sweeps agree, and a hand-stamped row would go
     * on passing after they stopped.
     *
     * This is the leak the claim could not close: a *live* orchestrator whose durable engine lost
     * the run (an Inngest restart without `--persist`, a redrive past its budget). Every signal
     * the reaper used to read said alive — Task in `review`, `solow.run` the newest Session, the
     * container carrying this process's own epoch — so `orphaned` came out false on every pass
     * for the life of the process, while `reportStrandedReviews` was concluding the opposite on
     * the same tick. Nothing else removes it: `reclaimOrphanedRuns` selects only `running` rows.
     * Verified on Docker 29.7.2 with one real container: reaped after this change, `running`
     * before it.
     */
    expect(await reportStrandedReviews(db, fakeRegistry(), fakeHub(), STALE)).toBe(1);
    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(1);
    expect(host.removed).toEqual(["solow-stranded"]);
  });

  it("keeps the container of a Task that resumed carrying the stranded reason", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-resumed", taskState: "review" });
    await db.insert(review).values({
      id: "rev-resumed",
      workspaceId: WS,
      sessionId,
      decision: "request_changes",
      actorUserId: "u1",
    });
    const host = fakeHost([{ name: "solow-resumed", taskId: "task-resumed", runId: sessionId }]);
    expect(await reportStrandedReviews(db, fakeRegistry(), fakeHub(), STALE)).toBe(1);

    // The late redrive: the run was not gone after all, took the decision, and started another
    // round. `resume-` in task-run.ts moves the Task to `running` without clearing the reason, so
    // the row now carries a verdict that has been overtaken — and an agent is working inside this
    // container. Reading the reason on its own would remove the workspace out from under it,
    // which is why the verdict is only read for a Task still sitting at the gate.
    await setTaskState(db, WS, "task-resumed", "running");

    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(0);
    expect(host.removed).toEqual([]);
  });

  it("removes a parked container whose run this still-live process lost", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-slept", taskState: "parked" });
    const host = fakeHost([{ name: "solow-slept", taskId: "task-slept", runId: sessionId }]);

    /*
     * The review leak's twin, one column over, and the one nothing at all was closing.
     *
     * A Task inside the five-hour `step.sleepUntil` whose durable run is then lost — an engine
     * restarted without `--persist`, a redrive past its budget — while the orchestrator process
     * carries on. Every signal here says alive: the Task reads `parked`, `solow.run` is the
     * newest Session, and the container carries this process's own epoch because *this* process
     * created it. So `orphaned` came out false on every sweep for ever, and unlike the review
     * case nothing else was even looking: `reclaimOrphanedRuns` selects only `running` rows, and
     * a sleeping run has no recorded decision for `reportStrandedReviews` to find.
     *
     * As with the review case the verdict is produced by the real sweep rather than a
     * `failureReason` typed in here — the point is that the two sweeps agree, and a hand-stamped
     * row would go on passing after they stopped agreeing.
     */
    expect(await reportStrandedParks(db, fakeRegistry(), fakeHub(), AFTER_PARK_WINDOW)).toBe(1);
    const count = await reapOrphanedContainers(
      host.executor,
      db,
      fakeRegistry(),
      AFTER_PARK_WINDOW,
    );

    expect(count).toBe(1);
    expect(host.removed).toEqual(["solow-slept"]);
  });

  it("keeps the container of a Task still sleeping out its quota window", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-sleeping", taskState: "parked" });
    const host = fakeHost([{ name: "solow-sleeping", taskId: "task-sleeping", runId: sessionId }]);

    // Twenty minutes into a five-hour sleep: past the quiet window the reaper waits out, and
    // nowhere near the wake-up the run set for itself. The reconciler says nothing about it, so
    // the reaper reads a Task no verdict has been reached about and leaves the workspace alone —
    // reaping here would take the container out from under work the deployment is deliberately
    // holding, which is the one thing the new tell must never cost.
    expect(await reportStrandedParks(db, fakeRegistry(), fakeHub(), STALE)).toBe(0);
    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(0);
    expect(host.removed).toEqual([]);
  });

  it("asks the daemon nothing about a container the database has already condemned", async () => {
    const db = createTestDb();
    const host = fakeHost([{ name: "solow-ghost", taskId: "task-deleted", runId: "sess-gone" }]);

    await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    // The claim is the only filter that costs a round trip per container, and a sweep runs every
    // sixty seconds over every container on the machine. The three cheaper answers come first
    // and `||` stops there — a deployment with fifty finished Tasks must not pay fifty execs to
    // learn what one `docker ps` and one select already said.
    expect(host.calls.some((cmd) => cmd.includes(CONTAINER_OWNER_PATH))).toBe(false);
  });
});

describe("a host that has no Docker on it", () => {
  it("resolves with nothing removed, and stops asking", async () => {
    const db = createTestDb();
    const host = fakeHost([], () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    });

    expect(await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE)).toBe(0);
    expect(host.calls).toHaveLength(1);

    // Latched, and this is the whole reason the arm resolves rather than throwing: it shares one
    // `.catch` with the other two sweeps, which logs without rethrowing. An arm that rejected on
    // a Docker-less host would print "reconciliation sweep failed" every sixty seconds for ever
    // and drown the signal the sweep exists to carry.
    expect(await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE)).toBe(0);
    expect(host.calls).toHaveLength(1);
  });

  it("says nothing when the daemon is merely down", async () => {
    const db = createTestDb();
    const host = fakeHost([], (cmd) =>
      cmd[1] === "ps"
        ? {
            exitCode: 1,
            stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
          }
        : undefined,
    );

    // Not latched, unlike a missing binary: a daemon comes back, and nothing is leaking that the
    // next sweep cannot find.
    expect(await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE)).toBe(0);
    expect(await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE)).toBe(0);
    expect(host.calls).toHaveLength(2);
  });
});

/**
 * The lifecycle invariants the sweep above is only safe because of (issue #96, AC-4).
 *
 * They belong to `ensureContainer`, but they are tested here because they are *this* file's
 * safety story: every skip above rests on the claim that a container a live run holds carries
 * this Task's current `solow.run` and this process's own claim. Both were once false, and the
 * reaper — reading them as if they were true — removed the live run's own container. So each case
 * below is stated as what the sweep would do if the invariant lapsed, and one of them runs the
 * real reaper over the real driver's container to say it outright.
 *
 * The daemon is a small model rather than a script of answers, because the interesting cases are
 * two `ensureContainer` calls in a row: the second one has to see what the first one built.
 */
const DRIVER_IDS: DockerIds = { workspaceId: WS, taskId: "task-driver", sessionId: "sess-1" };
const DRIVER_CONFIG: DockerExecutorConfig = {
  kind: "docker",
  image: "solow/agent:1",
  mounts: [],
  env: {},
};
const DRIVER_OPTS: DockerExecutorOpts = {
  jailRoot: "/srv/solow/worktrees/task-driver",
  worktreeRoot: "/srv/solow/worktrees",
  dockerBin: "docker",
  user: "1000:1000",
};

/** One container on a daemon that remembers what was done to it, including its tmpfs claim. */
function fakeDaemon(prepareExit = 0) {
  let container: { name: string; labels: Record<string, string>; owner: string | null } | undefined;
  let prepareRuns = 0;
  const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
  const unused = () => {
    // The driver reaches the host through `exec` and `spawn` and nothing else; reading the
    // host's own `fs` here would be describing the orchestrator's machine, not the container's.
    throw new Error("the Docker driver must not use the host executor's fs, forward or metrics");
  };

  const executor: Executor = {
    async exec(cmd) {
      // The host's own `realpath -m`, which the mount guard in `docker.ts` asks before it will
      // compose a bind — and which fails closed. A fake daemon that answered nothing would refuse
      // every mount, and every case below would fail for a reason that has nothing to do with the
      // container lifecycle it is here to pin.
      if (cmd[0] === "realpath") return ok(`${cmd[cmd.length - 1]}\n`);
      const verb = cmd[1];
      if (verb === "ps") return ok(container ? "c0ffee\n" : "");
      if (verb === "run") {
        const labels: Record<string, string> = {};
        for (const [index, arg] of cmd.entries()) {
          if (arg !== "--label") continue;
          const [key, ...value] = (cmd[index + 1] ?? "").split("=");
          labels[key ?? ""] = value.join("=");
        }
        container = { name: cmd[cmd.indexOf("--name") + 1] ?? "", labels, owner: null };
        return ok("c0ffee\n");
      }
      if (verb === "inspect") {
        if (!container) return { stdout: "", stderr: "No such object", exitCode: 1 };
        // Adoption asks its four questions in one round trip; creation asks only whether what it
        // just started is still up.
        return ok(
          (cmd[3] ?? "").includes("solow.cfg")
            ? `true|${container.labels["solow.cfg"]}|${container.labels["solow.run"]}|/${container.name}`
            : "true 0",
        );
      }
      if (verb === "rm") {
        container = undefined;
        return ok();
      }
      if (verb === "exec") {
        if (!container) return { stdout: "", stderr: "No such container", exitCode: 1 };
        if (cmd[3] === "cat") {
          return container.owner === null
            ? { stdout: "", stderr: "cat: can't open", exitCode: 1 }
            : ok(`${container.owner}\n`);
        }
        // The claim, written by the same `sh -c` the driver composes. Modelled rather than
        // waved through, because a claim that never lands is a container the reaper takes.
        const written = cmd.find((arg) => arg.startsWith("echo "));
        if (written) container.owner = written.split(" ")[1] ?? null;
        return ok();
      }
      return ok();
    },
    spawn(cmd) {
      // The only thing the driver spawns here is the prepare script, on stdin.
      if (cmd.includes("sh") && cmd.includes("-s")) prepareRuns += 1;
      return {
        stdin: { write: () => 0, flush: async () => 0, end: async () => {} },
        stdout: once(""),
        stderr: once(prepareExit === 0 ? "" : "apt-get: could not resolve archive.debian.org\n"),
        exited: Promise.resolve(prepareExit),
        kill: () => {},
      };
    },
    async baseEnv() {
      return {};
    },
    fs: { exists: unused, readFile: unused, writeFile: unused, list: unused, copy: unused },
    forward: unused,
    metrics: unused,
    async dispose() {},
  };

  return {
    executor,
    prepareRuns: () => prepareRuns,
    container: () => container,
  };
}

async function* once(text: string): AsyncGenerator<Uint8Array> {
  if (text) yield new TextEncoder().encode(text);
}

describe("the container lifecycle the reaper leans on", () => {
  it("adopts the container of the run it belongs to, and claims it again", async () => {
    const daemon = fakeDaemon();

    const first = await ensureContainer(daemon.executor, DRIVER_CONFIG, DRIVER_IDS, DRIVER_OPTS);
    const second = await ensureContainer(daemon.executor, DRIVER_CONFIG, DRIVER_IDS, DRIVER_OPTS);

    // The whole point of adoption: an Inngest replay, a retry or a second review round must
    // re-attach to the container the abandoned pass made rather than tear down a live agent's
    // workspace — so this must stay true whatever the cases below do to the relaunch path.
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.name).toBe(first.name);
    expect(daemon.container()?.owner).toBe(ORCHESTRATOR_EPOCH);
  });

  it("rebuilds rather than adopts a container left by a previous run of the Task", async () => {
    const daemon = fakeDaemon();

    await ensureContainer(daemon.executor, DRIVER_CONFIG, DRIVER_IDS, DRIVER_OPTS);
    const relaunch = await ensureContainer(
      daemon.executor,
      DRIVER_CONFIG,
      { ...DRIVER_IDS, sessionId: "sess-2" },
      DRIVER_OPTS,
    );

    /*
     * Docker labels are fixed at `docker run`, so adopting here left the container carrying the
     * *dead* run's id — and `solow.run` is what the sweep above reads to decide a container was
     * left behind by a previous run. The live run's own container therefore looked orphaned, and
     * the next sweep removed it: verified on Docker 29.7.2, one reaped container per ordinary
     * stop-then-relaunch. A relaunch is a new agent anyway; what the previous one left running
     * inside the container is not part of its inheritance.
     */
    expect(relaunch.created).toBe(true);
    expect(daemon.container()?.labels["solow.run"]).toBe("sess-2");
  });

  it("keeps the relaunched run's container through a sweep that has given up on the old one", async () => {
    const db = createTestDb();
    await seedTask(db, { taskId: "task-driver", taskState: "review" });
    // `startedAt` defaults to SQLite's own clock in milliseconds, and "newest Session" is what
    // the sweep compares against — two inserts inside one millisecond would leave which of them
    // is the relaunch up to the query planner.
    await new Promise((settle) => setTimeout(settle, 5));
    await db.insert(session).values({ id: "sess-2", workspaceId: WS, taskId: "task-driver" });
    const daemon = fakeDaemon();
    await ensureContainer(daemon.executor, DRIVER_CONFIG, DRIVER_IDS, DRIVER_OPTS);
    const live = await ensureContainer(
      daemon.executor,
      DRIVER_CONFIG,
      { ...DRIVER_IDS, sessionId: "sess-2" },
      DRIVER_OPTS,
    );

    // The real reaper over the real driver's container, on the path a `task.stop.requested`
    // cancellation takes: the `finally` dispose never runs, the next launch's Session is a new
    // row, and no agent is registered while a Task waits at the review gate. This is the case
    // that used to remove the container the operator was watching.
    const host = fakeHost([
      {
        name: live.name,
        taskId: "task-driver",
        // The label the driver actually wrote, never a restatement of it: that label being the
        // *previous* run's is the whole defect, and a test that spelled out the right answer
        // here would have gone on passing through it.
        runId: daemon.container()?.labels["solow.run"] ?? "",
        owner: daemon.container()?.owner ?? null,
      },
    ]);
    const count = await reapOrphanedContainers(host.executor, db, fakeRegistry(), STALE);

    expect(count).toBe(0);
    expect(host.removed).toEqual([]);
  });

  it("removes the container a prepare script failed on, so no later pass can adopt it", async () => {
    const daemon = fakeDaemon(100);
    const config = { ...DRIVER_CONFIG, prepareScript: "apt-get install -y jq" };
    const failed = /prepare script failed \(exit 100\)/;

    const first = createDockerExecutor(daemon.executor, config, DRIVER_IDS, DRIVER_OPTS);
    await expect(first.exec(["true"])).rejects.toThrow(failed);
    // A fresh executor is what the next Inngest pass builds — the memo lives on the executor.
    const second = createDockerExecutor(daemon.executor, config, DRIVER_IDS, DRIVER_OPTS);
    await expect(second.exec(["true"])).rejects.toThrow(failed);

    /*
     * The script runs only on the pass that *created* the container, so leaving a half-prepared
     * one behind meant the next pass adopted it with `created: false`, skipped the script and
     * resolved: verified live, where passes 2 and 3 ran the agent in a container whose prepare
     * script had exited 100 — a profile that cannot install its tooling failing silently into a
     * Task that goes on to fail for some unrelated-looking reason.
     */
    expect(daemon.prepareRuns()).toBe(2);
    expect(daemon.container()).toBeUndefined();
  });
});

/**
 * That the sweep is actually reached, and that it is the sweep that closes the leak.
 *
 * Every case above assumes it and none of them shows it — and the assumption was false for a whole
 * round. `reportStrandedParks` was written, unit-tested and correct while the sweep in `index.ts`
 * listed three arms and called it from none of them: repo-wide, the name appeared in its own
 * definition and in test files. Driving the real `startWebSocketServer` with a fake Docker host
 * reproduced exactly what that cost — `STATE: parked REASON: null REMOVED: []` after the first
 * sweep, identical to the behaviour before the tell existed.
 *
 * So the first case here drives the real `reconcileSweep`, the function `startWebSocketServer`
 * schedules, with nothing faked but the daemon and the clock. The second reads the schedule as
 * text, and says so: `startWebSocketServer` opens a socket and waits `RECONCILE_GRACE_MS` before
 * its first pass, so driving *it* would cost the suite twenty seconds and a port to assert one
 * call. Text pins the two things a regression would actually do to the schedule — take the sweep
 * off the interval, or run it once at boot — and nothing about how the sweep is written.
 */
describe("the sweep it is an arm of", () => {
  it("reads its own tell's verdict in the pass that writes it", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-swept", taskState: "parked" });
    const host = fakeHost([{ name: "solow-swept", taskId: "task-swept", runId: sessionId }]);

    await reconcileSweep(
      { db, registry: fakeRegistry(), dockerHost: host.executor },
      AFTER_PARK_WINDOW,
    );

    /*
     * Both halves, because either alone is a sweep that does nothing useful: the reason is the
     * only thing that will ever tell an operator why this Task stopped, and the removal is the
     * only thing that gives the machine its CPU reservation and memory ceiling back.
     *
     * *In one pass* is the other half of the assertion, and it is about ordering rather than
     * speed. These arms used to share one `Promise.all`, so the reaper read this row on the same
     * tick the tell was stamping it, saw no verdict, and formed its conclusion from a table that
     * was already out of date — verified live, first sweep stamps and removes nothing.
     *
     * The clock is what compresses this into one pass: the stamp resets `updatedAt`, so on a real
     * clock the container serves the quiet window `filter 3 — quiet` gives every row and goes ten
     * minutes later. That delay is deliberate and tested above; what must not depend on a later
     * sweep is the *reasoning*, which is what the arms racing each other broke.
     */
    const [row] = await db.select().from(task).where(eq(task.id, "task-swept")).limit(1);
    expect(row?.failureReason).toBe(STRANDED_PARK_REASON);
    expect(host.removed).toEqual(["solow-swept"]);
  });

  it("leaves a live preflight's container standing in the pass that condemns its run", async () => {
    const db = createTestDb();
    // A `running` Task inside `executor-preflight`: no agent registered (that step holds no
    // `AgentHandle` to register), no session event (an image pull produces none), and a container
    // carrying this process's own epoch, because this process is the one building it.
    const { sessionId } = await seedTask(db, { taskId: "task-preflight" });
    const host = fakeHost([
      { name: "solow-preflight", taskId: "task-preflight", runId: sessionId },
    ]);
    /*
     * The one place in this file where a row is back-dated rather than the clock moved, and it has
     * to be. What is being modelled is a *long preflight*, and its length is the Session's age —
     * while the row whose staleness rule is under test, `task.updatedAt`, has to be the one the
     * product itself writes during the sweep. `setTaskState` stamps that from the wall clock, so
     * a single injected clock far enough ahead to make `reclaimOrphanedRuns` condemn would also
     * put the reaper twenty minutes past a verdict written a millisecond earlier — a pair of
     * readings that cannot happen in one real pass, and the arrangement under which this case
     * passed before the cushion was widened at all.
     */
    await db
      .update(session)
      .set({ startedAt: new Date(Date.now() - RECLAIM_STALE_MS * 2).toISOString() })
      .where(eq(session.id, sessionId));

    await reconcileSweep({ db, registry: fakeRegistry(), dockerHost: host.executor }, NOW);

    /*
     * Half of this is the hazard, stated rather than fixed. Ten minutes of that silence is all
     * `reclaimOrphanedRuns` needs, and it files the run as `interrupted` — nothing in a reaper can
     * take that back, and no signal available to either sweep tells a pull from a corpse.
     *
     * What must not also happen is the removal, and it used to happen in this same call:
     * `heldByRun` reads the `failed` row the reclaim arm has just written, `!held` short-circuits
     * filter 4 before the container's own claim is ever consulted, and the prepare script is
     * killed with 137 — an `ExecutorUnavailableError` that fails a round that was still working.
     * Reproduced through this exact sweep, and again on Docker 29.7.2 against a real container
     * labelled for a `running` Task and carrying this process's epoch: one pass, and it was gone.
     */
    const [row] = await db.select().from(task).where(eq(task.id, "task-preflight")).limit(1);
    expect(row?.state).toBe("failed");
    expect(row?.failureReason).toBe(INTERRUPTED_REASON);
    expect(host.removed).toEqual([]);

    /*
     * And the boundary the comments in `reap.ts` now claim, pinned rather than described: the
     * cushion buys the run one more quiet window measured from the verdict, and no more. A
     * preflight still going after `2 × RECLAIM_STALE_MS` loses its container exactly as before.
     * Closing *that* needs the run lifecycle to publish a container before an agent owns it, which
     * is not a change any sweep can make — so this case exists to fail the day someone believes
     * the hazard is closed.
     */
    await reconcileSweep(
      { db, registry: fakeRegistry(), dockerHost: host.executor },
      () => new Date(Date.now() + RECLAIM_STALE_MS * 3),
    );
    expect(host.removed).toEqual(["solow-preflight"]);
  });

  it("runs that sweep on a repeating timer, not once at boot", async () => {
    const source = await Bun.file(new URL("../index.ts", import.meta.url)).text();
    const from = source.indexOf("export async function reconcileSweep(");
    const to = source.indexOf("function sweepFailed(");
    // Both ends located before anything is sliced: a `-1` here would quietly widen the slice to
    // the whole file, and the imports at the top of `index.ts` would then satisfy the assertions
    // below for arms that nothing calls.
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);

    const body = source.slice(from, to);
    expect(body).toContain("reportStrandedParks(");
    expect(body).toContain("reapOrphanedContainers(");
    // And the sweep is what repeats. The `setTimeout` around it is the twenty-second grace this
    // module's own `REAP_GRACE_MS` mirrors, not the schedule.
    expect(source).toContain("setInterval(() => void reconcileSweep(deps)");
  });
});
