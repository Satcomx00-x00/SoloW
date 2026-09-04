import type { TaskCompletionOutcome } from "@solow/contracts";
import { parseSessionEventPayload } from "@solow/contracts";
import { INTERRUPTED_REASON, STRANDED_REVIEW_REASON } from "@solow/core";
import { type Db, review, session, sessionEvent, task } from "@solow/db";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import type { AgentRegistry } from "./agent/registry.js";
import {
  appendSessionEvent,
  nextSessionEventSeq,
  recordTaskCompletion,
  setSessionState,
  setTaskState,
} from "./data.js";
import type { EventHub } from "./ws/hub.js";

/**
 * Reclaim a Task left `running` by a process that is provably gone (reported directly: an Owner
 * watching a Task's input answer "No agent is running" forever after an orchestrator restart).
 *
 * `running` is *supposed* to mean "the durable workflow's `agent-run` step is either executing or
 * about to be redriven" — Inngest retries an incomplete step from the top, so a genuine restart
 * ordinarily heals itself the moment the workflow resumes and registers again with
 * `agentRegistry` (see that module's own doc comment). This function exists for the case that
 * doesn't heal: the Inngest server itself lost the in-flight run (its dev server is in-memory
 * only, and a hosted deployment can still drop a run past its retry budget), and nothing will
 * ever redrive it. Left alone, the Task stays `running` — and every input the Owner sends
 * bounces off an empty registry — forever.
 *
 * Called on a timer for the life of the process, not once at boot — and the difference is the
 * whole of a reported incident. The sweep used to be a single `setTimeout` twenty seconds after
 * start-up, which answers exactly one shape of failure: a Task already orphaned by the *previous*
 * process. A Task orphaned *later* was never looked at again. That is what happened: an
 * orchestrator booted at 11:52, swept at 11:52:37 and correctly left a Task alone because its run
 * was genuinely alive and registered; that run then died at 13:54 with its last turn written and
 * its work committed, and the Task sat in `running` — its input box answering "No agent is
 * running" — for the hour and a half until an Owner came asking. The net was real, and it had
 * already been used up before the fall.
 *
 * Two independent signals have to agree before anything is reclaimed, because a periodic sweep
 * can catch a healthy run in a way a boot-time one cannot:
 *
 * 1. **Not in `agentRegistry`.** Registration spans the whole `agent-run` step, so a live agent —
 *    including one sitting inside a twenty-minute build — is always present. This is conclusive
 *    when it is true.
 * 2. **Silent for `RECLAIM_STALE_MS`.** The registry is empty in the gaps *between* durable steps
 *    too — the moment after `agent-run` returns and before `to-review` commits is exactly such a
 *    gap, and it is milliseconds wide in the happy path. Reclaiming there would kill a run that
 *    was about to finish. So a Task is only orphaned once its Session has also produced nothing
 *    for long enough that no ordinary gap could explain it.
 *
 * Together they cannot rule out every false positive — a redrive that stalls for longer than the
 * window and then resumes would be reclaimed — but the alternative (a Task stuck showing
 * "running" with no way to act on it) is strictly worse, and reclaiming always leaves a one-click
 * Retry, never data loss: the worktree and its commits are untouched.
 */

/**
 * How quiet a `running` Task has to have gone before the sweep will call it orphaned.
 *
 * Sized against the widest legitimate gap between two durable steps, not against how long a tool
 * call takes — a long tool call happens *inside* `agent-run`, where the registry check settles it
 * first. Ten minutes is far beyond any observed step scheduling delay and still bounds how long
 * an Owner stares at a dead Task.
 */
export const RECLAIM_STALE_MS = 10 * 60 * 1000;
export async function reclaimOrphanedRuns(
  db: Db,
  registry: Pick<AgentRegistry, "get">,
  hub: Pick<EventHub, "publish" | "boardChannel" | "taskChannel">,
  now: () => Date = () => new Date(),
): Promise<number> {
  const running = await db
    .select({ id: task.id, workspaceId: task.workspaceId, updatedAt: task.updatedAt })
    .from(task)
    .where(eq(task.state, "running"));

  let reclaimed = 0;
  for (const row of running) {
    if (registry.get(row.workspaceId, row.id)) continue;

    const [live] = await db
      .select({ id: session.id, startedAt: session.startedAt })
      .from(session)
      .where(
        and(
          eq(session.workspaceId, row.workspaceId),
          eq(session.taskId, row.id),
          ne(session.state, "closed"),
        ),
      )
      .orderBy(desc(session.startedAt))
      .limit(1);

    /*
     * The newest Session whatever state it is in, which is not always the live one.
     *
     * A Task can reach this sweep with its Session already closed — a previous sweep closed it,
     * or the run did — and be `running` again because someone moved it back on the board. The
     * evidence that decides between "interrupted" and "failed" lives in that Session's log, so
     * looking only at a non-closed Session would find nothing and file real work as a failure,
     * which is the exact case this rewrite exists to stop.
     */
    const [newest] = await db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.workspaceId, row.workspaceId), eq(session.taskId, row.id)))
      .orderBy(desc(session.startedAt))
      .limit(1);
    const evidenceIn = live?.id ?? newest?.id ?? null;

    // The second signal. `lastSpoke` falls back through what is available: the newest event this
    // run produced, else the Session's own start (a launch that hung before the agent's first
    // word has produced nothing, and its Session's age is the honest measure of how long), else
    // the Task's last write for a `running` Task carrying no Session at all — which should not
    // happen, and if it does the Task is orphaned by definition.
    const lastSpoke = live ? await latestActivity(db, live.id, live.startedAt) : row.updatedAt;
    if (now().getTime() - Date.parse(lastSpoke) < RECLAIM_STALE_MS) continue;

    /*
     * Orphaned mid-work, or orphaned having finished — and, in between, orphaned having done
     * real work it never got to declare.
     *
     * The sweep used to answer this from one signal, the `agent_done` marker, and file anything
     * without it as a failure. That was wrong in the most common case there is: an agent that
     * finishes its turn and waits for the operator has not ended its process, so it writes no
     * marker, and a `bun --hot` reload or a restart then buried real work in the Failed column.
     *
     * So it now reads the evidence in order of strength:
     *
     *   1. `agent_done`      — the agent said it finished. Record the declaration; a person opens
     *                          the gate (the run itself no longer moves a Task to review either).
     *   2. a captured `diff` — the agent produced a change at some turn boundary. The work exists
     *                          and is described; the Task goes back to `ready` to be resumed, and
     *                          nothing is filed as a failure.
     *   3. nothing at all    — no marker, no change, no evidence the run achieved anything. This
     *                          is the only case that is a failure, and it is the honest one.
     *
     * What none of the three does is capture a diff: the worktree deps belong to the run, so a
     * sweep can only read what the run already wrote down.
     */
    const finished = evidenceIn ? await completionMarker(db, evidenceIn) : null;
    const endedAt = now().toISOString();

    if (finished) {
      await recordTaskCompletion(db, row.workspaceId, row.id, {
        outcome: finished.outcome ?? "changes_ready",
        summary: finished.summary ?? null,
        at: endedAt,
      });
      if (live) {
        await setSessionState(db, row.workspaceId, live.id, "awaiting_review", {
          diffRef: finished.branch,
        });
        await appendSessionEvent(db, row.workspaceId, {
          sessionId: live.id,
          seq: await nextSessionEventSeq(db, row.workspaceId, live.id),
          payload: { kind: "state", from: "running", to: "running", reason: RECOVERED_REASON },
        });
      }
      // The Task does not move: it is finished and waiting for a person, which is exactly what
      // the board now draws. Announced so the card gains its control without a reload.
      announce(hub, row, "running", endedAt);
      reclaimed += 1;
      continue;
    }

    const produced = evidenceIn ? await capturedChange(db, evidenceIn) : false;
    if (produced) {
      // Work exists and is readable. Sending this to `failed` is what buried it; `ready` is the
      // state a person can act on, and the reason says what happened to the run rather than
      // implying something was wrong with the work.
      await setTaskState(db, row.workspaceId, row.id, "ready", { failureReason: null });
      if (live) {
        await setSessionState(db, row.workspaceId, live.id, "closed", { endedAt });
        await appendSessionEvent(db, row.workspaceId, {
          sessionId: live.id,
          seq: await nextSessionEventSeq(db, row.workspaceId, live.id),
          payload: { kind: "state", from: "running", to: "ready", reason: INTERRUPTED_REASON },
        });
      }
      announce(hub, row, "ready", endedAt);
      reclaimed += 1;
      continue;
    }

    await setTaskState(db, row.workspaceId, row.id, "failed", {
      failureReason: INTERRUPTED_REASON,
    });
    if (live) {
      await setSessionState(db, row.workspaceId, live.id, "closed", { endedAt });
      // The transcript's own record of why, in the same vocabulary a normal run failure uses
      // (see `recordTransition` in task-run.ts) — an Owner reading the log afterwards sees a
      // stated reason, not a state that changed with no explanation.
      await appendSessionEvent(db, row.workspaceId, {
        sessionId: live.id,
        seq: await nextSessionEventSeq(db, row.workspaceId, live.id),
        payload: { kind: "state", from: "running", to: "failed", reason: INTERRUPTED_REASON },
      });
    }
    announce(hub, row, "failed", endedAt);
    reclaimed += 1;
  }
  return reclaimed;
}

/**
 * The other way a run goes missing, and the one nobody watches for.
 *
 * A Task at the review gate is a run parked in `waitForEvent("review.decided")`. Lose that run —
 * a durable engine restarted without `--persist`, a redrive that never came back — and the wait
 * is gone while the Task still reads `review`. The operator then approves, `review.decide`
 * records the decision and publishes the event, nothing is listening, and the Task sits in
 * `review` for ever with a decision that was made and never applied. Approve and Request changes
 * look dead, and there is nothing on screen to say why.
 *
 * The distinction that makes this safe to sweep: **a Task waiting for a person is not stranded.**
 * Only one carrying a *recorded decision* that did not take effect is, and that is what is looked
 * for here — a review row for the Session, with the Task still sitting at the gate long after.
 *
 * What it does not do is apply the decision. Committing here would be a second implementation of
 * the approve path, running outside the durable loop that owns worktrees — the "two orchestration
 * paths with undefined precedence" this codebase refuses everywhere else. It names the condition
 * instead, so a person can retry, and the run that retries is the one that owns the work.
 */
export async function reportStrandedReviews(
  db: Db,
  registry: Pick<AgentRegistry, "get">,
  hub: Pick<EventHub, "publish" | "boardChannel" | "taskChannel">,
  now: () => Date = () => new Date(),
): Promise<number> {
  const inReview = await db
    .select({ id: task.id, workspaceId: task.workspaceId, updatedAt: task.updatedAt })
    .from(task)
    .where(and(eq(task.state, "review"), isNull(task.failureReason)));

  let reported = 0;
  for (const row of inReview) {
    if (registry.get(row.workspaceId, row.id)) continue;
    if (now().getTime() - Date.parse(row.updatedAt) < RECLAIM_STALE_MS) continue;

    const [decided] = await db
      .select({ id: review.id })
      .from(review)
      .innerJoin(session, eq(session.id, review.sessionId))
      .where(and(eq(review.workspaceId, row.workspaceId), eq(session.taskId, row.id)))
      .limit(1);
    // No decision means a person has simply not looked yet. That is the gate working.
    if (!decided) continue;

    await setTaskState(db, row.workspaceId, row.id, "review", {
      failureReason: STRANDED_REVIEW_REASON,
    });
    const message = {
      kind: "status" as const,
      taskId: row.id,
      state: "review" as const,
      at: now().toISOString(),
    };
    hub.publish(hub.boardChannel(row.workspaceId), message);
    hub.publish(hub.taskChannel(row.workspaceId, row.id), message);
    reported += 1;
  }
  return reported;
}

/**
 * The `failureReason` a Task carries when the run sleeping out its quota window never came back.
 *
 * Not a failure of the work: the worktree and its commits are untouched, and one Retry starts the
 * round the sleep was supposed to start. What it names is that nothing will happen on its own —
 * a Task showing `parked` says "waiting for a quota window", and this is the row saying that
 * window closed hours ago with nobody there to notice.
 *
 * Written beside its writer rather than in `@solow/core` next to `STRANDED_REVIEW_REASON`, which
 * is there because the board matches on it and gives it its own words. This one has no card
 * treatment yet and falls into the generic reason badge; move it across in the change that gives
 * it one, so there is never a reason string the board can render only as a machine name.
 *
 * Cleared by the park step itself when its sleep returns (`park-woke-` in task-run.ts, through
 * `clearStrandedPark` below), so a run that was merely late is not still carrying a verdict that
 * has been overtaken. Nothing else in the orchestrator clears it: `updateTaskState` in the web DAL
 * does, when an operator moves the card, and that used to be the only thing that did.
 */
export const STRANDED_PARK_REASON = "park_never_resumed";

/**
 * Take that verdict back — but only from a row that is still the one it was written about.
 *
 * A conditional update rather than `setTaskState(db, ws, id, "parked", { failureReason: null })`,
 * and the precondition is the whole point: `setTaskState` has none, and five hours is a long time
 * to assume nothing moved. An operator who finished the Task or sent it back to `ready` while the
 * run slept had that decision overwritten by the sleeper waking up, which then announced `parked`
 * over the top of it — and the clobbered row dropped out of `reclaimOrphanedRuns` (it selects only
 * `running`) into this sweep's own window. What the sleeper is entitled to take back is the
 * verdict written *about* its sleep, never the state of a Task somebody else has since moved.
 *
 * The state test lives in the `where` so the read and the decision cannot come apart, and the
 * answer is the write's own: `true` only if a `parked` row was still there to update. The caller
 * announces on it — a row that moved has already been announced by whoever moved it.
 *
 * `updatedAt` moves with the clear, which is what stops this sweep reaching the same conclusion
 * again while the woken round runs: the round leaves the Task reading `parked` throughout, so the
 * row's own last write is half of what `reportStrandedParks` measures.
 *
 * Here rather than in `data.ts` beside `setTaskState` because it is this reason's inverse, and
 * `reportStrandedParks` above is the only thing that writes it: the one write that takes a verdict
 * back belongs next to the one that reaches it. A `setTaskState` able to carry an expected state
 * would subsume this and should.
 */
export async function clearStrandedPark(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<boolean> {
  const cleared = await db
    .update(task)
    .set({ failureReason: null, updatedAt: new Date().toISOString() })
    .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId), eq(task.state, "parked")))
    .returning({ id: task.id });
  return cleared.length > 0;
}

/**
 * How long the review gate waits for a person before the run gives up (`review_timeout`).
 *
 * The second copy of a value `task-run.ts` owns — the `timeout` on `await-review-`, exported there
 * as `REVIEW_WAIT_TIMEOUT` — kept here for the same reason `PARK_WINDOW_MS` is: a sweep running
 * every sixty seconds must not import the durable workflow module. It bounds guard 2 of
 * `reportStrandedParks`, so the drift direction is the same one that matters everywhere in this
 * file — grow the gate's wait without growing this, and the sweep starts condemning runs that are
 * still legitimately waiting for a reviewer. `reconcile.test.ts` pins the two equal.
 */
export const REVIEW_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a parked run sleeps before it wakes itself up.
 *
 * The literal from `task-run.ts`'s park step — `step.sleepUntil(..., now + PARK_SLEEP_MS)` —
 * restated here rather than imported, because the reconciler must not pull the durable workflow
 * module (and everything it drags with it) into a sweep that runs every sixty seconds. That makes
 * this a second copy of a value with one real owner, and the drift that matters has a direction:
 * if the park step's window ever *grows* and this does not, the tell below starts firing on runs
 * that are still legitimately asleep.
 *
 * So the duplication is pinned rather than trusted: the park step exports `PARK_SLEEP_MS`, and
 * `reconcile.test.ts` asserts the two are equal. Changing one alone is a red test, not a sweep
 * that starts condemning sleepers — which is the guarantee the comment on its own could not give.
 */
export const PARK_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * The third way a run goes missing, and the one nothing at all was watching for.
 *
 * `running` heals through `reclaimOrphanedRuns` and `review` through `reportStrandedReviews`.
 * `parked` — a run inside the five-hour `step.sleepUntil` that waits out a quota window — healed
 * through neither: the reclaim sweep selects only `running` rows, and a sleeping run has no
 * recorded decision to strand. Lose that run (an engine restarted without `--persist`, a redrive
 * past its retry budget) and the Task reads `parked` for ever, nothing ever wakes it, and its
 * executor container keeps the CPU reservation and memory ceiling it was given — the leak
 * `reapOrphanedContainers` could not close, because every signal it reads says a run is coming
 * back. Nothing on the board says why the Task never resumed, either.
 *
 * **What tells "lost" from "legitimately asleep" is the clock, and nothing but the clock**, which
 * is why three things have to agree before anything is named:
 *
 * 1. **Not in `agentRegistry`.** Conclusive when it answers: registration spans the whole
 *    `agent-run` step, so a run that woke and is working is always present. It matters more here
 *    than in either neighbour, because the park step moves the Task out of `running` and nothing
 *    ever moves it back — a woken run does its next round with the row still reading `parked`.
 * 2. **Its Session is not at the review gate — or that gate's own wait has itself run out.** Same
 *    row, later in that round: a run that woke, worked and finished leaves the Session
 *    `awaiting_review` while the Task still reads `parked` (only an operator opening the gate
 *    moves it), and then waits in `waitForEvent` for up to seven days. That is a run waiting for a
 *    *person*, which is never stranded — the same distinction `reportStrandedReviews` draws, and
 *    skipping it would condemn every Task that ever parked and then finished a round.
 *
 *    Left unbounded it was not a distinction but a permanent leak, because nothing else in the
 *    orchestrator can reach such a row: `reportStrandedReviews` selects `task.state === "review"`
 *    and a parked round never moves the Task there (`to-review-` records the completion and leaves
 *    the Task state alone), while `heldByRun` reads `parked` with no reason as held for ever, so
 *    the reaper never takes the container either. Reproduced with three sweeps at a clock forty
 *    park windows out: nothing reported, nothing removed, and no later sweep that would. So the
 *    skip now lasts exactly as long as the wait it stands for — `REVIEW_WAIT_MS +
 *    RECLAIM_STALE_MS` of silence — after which either the run is gone or its own `waitForEvent`
 *    has timed out and returned `review_timeout`, and in both of those the Task stays `parked`
 *    with nothing coming to move it. That is the sentence this reason exists to say, even though
 *    what actually ran out here was a reviewer's attention rather than a quota window; the row
 *    names the state a person has to act on, and there is no second reason string for the shape.
 * 3. **Silent for longer than a whole park window.** `PARK_WINDOW_MS + RECLAIM_STALE_MS` measured
 *    from the last thing this Task or its Session actually did. A run still inside its window has
 *    not reached its own wake-up time yet, so by construction it cannot be reported; a run that
 *    passed it and produced nothing has missed a deadline it set itself.
 *
 * **The worst case when it is wrong** is an engine so backed up that a wake-up is more than a
 * whole park window plus ten minutes late. The Task keeps its state, its worktree and its commits
 * — this writes a reason and nothing else — and if the reaper has meanwhile taken the container,
 * `ensureContainer` finds nothing to adopt and builds a fresh one over the same host worktree,
 * re-running the profile's prepare script. Verified on Docker 29.7.2 against a real container:
 * after a `docker rm -f` the resumed executor rebuilt and started it, the bind-mounted worktree
 * read back byte-identical, and the only thing lost was a file written inside the container's own
 * filesystem.
 *
 * **"Rebuild, never the work" is the good case, not the guaranteed one, and the correction is why
 * two things now stand between a stamp and a removal.** A `docker rm -f` issued while an exec is
 * running in the container kills that exec with 137 — verified on 29.7.2 — and a prepare script
 * killed that way becomes an `ExecutorUnavailableError` that fails the round. Nothing rebuilds
 * anything in that story. The exposure was not "until the round ends" either: the Task stays
 * `parked` for the whole of the round a woken run does, and only an operator moving the card
 * cleared `failureReason`, so an overtaken stamp stayed readable to the reaper across every gap
 * between that round's durable steps.
 *
 * So the park step now clears the reason the moment its sleep returns, before the round it wakes
 * into reaches an executor — and only while the row still reads `parked`, since a Task an operator
 * moved during the sleep is theirs and not the sleeper's — and `reap.ts` measures its
 * `RECLAIM_STALE_MS` quiet window from a Task row's own last write rather than from what that row
 * says. What is left is a wake-up whose clearing write never lands at all: the process dies
 * between the sleep returning and that step committing. Covering it means the run lifecycle
 * publishing a container's existence before an agent exists to own it, since the container is
 * built inside `executor-preflight`, a durable step that holds no `AgentHandle` to register: a
 * change to the run lifecycle, and not one any sweep can make.
 *
 * Like its twin this names the condition and does not act on it: the Task stays `parked`, so the
 * row still says what happened, and a person retries. Applying anything here would be a second
 * orchestration path over worktrees the durable run owns.
 */
export async function reportStrandedParks(
  db: Db,
  registry: Pick<AgentRegistry, "get">,
  hub: Pick<EventHub, "publish" | "boardChannel" | "taskChannel">,
  now: () => Date = () => new Date(),
): Promise<number> {
  const parked = await db
    .select({ id: task.id, workspaceId: task.workspaceId, updatedAt: task.updatedAt })
    .from(task)
    .where(and(eq(task.state, "parked"), isNull(task.failureReason)));

  let reported = 0;
  for (const row of parked) {
    if (registry.get(row.workspaceId, row.id)) continue;

    const [newest] = await db
      .select({ id: session.id, state: session.state, startedAt: session.startedAt })
      .from(session)
      .where(and(eq(session.workspaceId, row.workspaceId), eq(session.taskId, row.id)))
      .orderBy(desc(session.startedAt))
      .limit(1);

    // The newest sign of life from either half of the pair, because they record different halves
    // of the same round: the Session carries everything the agent said, and the Task row carries
    // the park itself. Taking only one of them would read a run that had just parked, or one
    // mid-round in a Session that has not spoken for a while, as older than it is.
    const spokeAt = newest ? await latestActivity(db, newest.id, newest.startedAt) : row.updatedAt;
    const lastSpoke = Math.max(Date.parse(spokeAt), Date.parse(row.updatedAt));
    // Guards 2 and 3 are one comparison against two different windows, because they are the same
    // question asked about two different waits: a Session at the gate is inside a seven-day one,
    // and everything else is inside a five-hour one. Neither is open-ended.
    const waiting =
      newest?.state === "awaiting_review"
        ? REVIEW_WAIT_MS + RECLAIM_STALE_MS
        : PARK_WINDOW_MS + RECLAIM_STALE_MS;
    if (now().getTime() - lastSpoke < waiting) continue;

    await setTaskState(db, row.workspaceId, row.id, "parked", {
      failureReason: STRANDED_PARK_REASON,
    });
    const message = {
      kind: "status" as const,
      taskId: row.id,
      state: "parked" as const,
      at: now().toISOString(),
    };
    hub.publish(hub.boardChannel(row.workspaceId), message);
    hub.publish(hub.taskChannel(row.workspaceId, row.id), message);
    reported += 1;
  }
  return reported;
}

/** When this Session last produced anything, falling back to when it began. */
async function latestActivity(db: Db, sessionId: string, startedAt: string): Promise<string> {
  const [newest] = await db
    .select({ at: sessionEvent.at })
    .from(sessionEvent)
    .where(eq(sessionEvent.sessionId, sessionId))
    .orderBy(desc(sessionEvent.at))
    .limit(1);
  return newest?.at ?? startedAt;
}

/**
 * The reason a Task recovered by this sweep carries into review.
 *
 * Distinct from `interrupted`, and the distinction is the point: both say the run was lost, and
 * only one says the work survived it. A reviewer opening this Task is looking at real changes
 * that nothing else would have shown them.
 */
export const RECOVERED_REASON = "recovered_after_restart";

/**
 * The `agent_done` this Session ended on, if it ended on one.
 *
 * Read as "the newest marker in the log", not "the last event is a marker": an agent's final turn
 * and the compaction step both land after it, and neither of them means the agent did not finish.
 * There is no ambiguity to resolve — a marker is only ever written once the agent has stopped
 * having completed, so its presence is the fact, whatever came afterwards.
 */
async function completionMarker(
  db: Db,
  sessionId: string,
): Promise<{
  branch: string;
  outcome: TaskCompletionOutcome | null;
  summary: string | null;
} | null> {
  const [newest] = await db
    .select({ payload: sessionEvent.payload })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.kind, "agent_done")))
    .orderBy(desc(sessionEvent.seq))
    .limit(1);
  if (!newest) return null;
  const parsed = parseSessionEventPayload("agent_done", newest.payload);
  if (parsed.kind !== "agent_done") return null;
  return {
    branch: parsed.branch,
    outcome: parsed.outcome ?? null,
    summary: parsed.summary ?? null,
  };
}

/**
 * Whether this Session produced a change anyone can still read.
 *
 * The second-strongest evidence there is, and the one that decides between "interrupted" and
 * "failed". A `diff` record means the agent edited something and the orchestrator captured it —
 * at a turn boundary during the run, or at the gate. Work that is described in the log is work
 * that survives the run being lost, and filing it as a failure is what buried it.
 */
async function capturedChange(db: Db, sessionId: string): Promise<boolean> {
  const [any] = await db
    .select({ id: sessionEvent.id })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.kind, "diff")))
    .limit(1);
  return any !== undefined;
}

/**
 * Tell everyone watching. Both channels, as `announce` in task-run.ts does: whoever is looking at
 * this Task's own page is the person most likely to be waiting on this reclaim, and they were the
 * ones it never reached.
 */
function announce(
  hub: Pick<EventHub, "publish" | "boardChannel" | "taskChannel">,
  row: { id: string; workspaceId: string },
  state: "failed" | "review" | "ready" | "running",
  at: string,
): void {
  const message = { kind: "status" as const, taskId: row.id, state, at };
  hub.publish(hub.boardChannel(row.workspaceId), message);
  hub.publish(hub.taskChannel(row.workspaceId, row.id), message);
}
