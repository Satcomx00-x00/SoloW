import type { SessionEventPayload, TaskState } from "@solow/contracts";
import { PARK_WINDOW_MS } from "@solow/core";
import { claimTaskRunSlot } from "@solow/db";
import { captureException, logStateTransition } from "@solow/observability";
import { appendSessionEvent, nextSessionEventSeq, setTaskState } from "../../../data.js";
import { clearStrandedPark } from "../../../reconcile.js";
import { toTaskEvent } from "../../../ws/replay.js";
import type { RunScope } from "./scope.js";

/*
 * Parking and failing: the ways a run stops short of a review gate, and what each one writes,
 * announces and reports on its way out.
 */

/**
 * How long a run parked on an exhausted quota sleeps before it wakes itself up.
 *
 * `PARK_WINDOW_MS` from `@solow/core`, not a value of its own: the reconcile sweep and the web
 * app read that window to decide when a parked run is lost, and neither may import this module.
 * A literal here would be a second copy with a direction to its drift — grow the sleep alone and
 * the sweep condemns runs still legitimately asleep. `reconcile.test.ts` pins the two equal, and
 * this export is what lets it.
 */
export const PARK_SLEEP_MS = PARK_WINDOW_MS;

/**
 * Fail the run, say why, and stop — the shape `prepare-failed` and `executor-unavailable`
 * already use, factored out because the Workflow entry adds three more of them.
 *
 * The state write and the transition record stay inside one `step.run` for the reason those
 * two do: split apart, an Inngest retry appends a second copy of the transition.
 */
export async function failRun(
  scope: RunScope,
  stepId: string,
  reason: string,
  /**
   * The Workflow Step being failed under. Ahead of `from` in the list on purpose: `from` has a
   * default that most call sites take, and a required parameter behind it would force every one
   * of them to restate the default just to reach this.
   */
  workflowStepId: string | null,
  /** The state being left. The row's own at entry; `running` once the loop is turning. */
  from: TaskState = scope.ctx.task.state,
): Promise<{ taskId: string; result: string }> {
  const { step, db, log, workspaceId, taskId, recordTransition, announce } = scope;
  await step.run(stepId, async () => {
    await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
    await recordTransition(from, "failed", workflowStepId, reason);
  });
  logStateTransition(log, { workspaceId, taskId, from, to: "failed" });
  announce("failed");
  captureException(log, new Error(reason), { failureReason: reason });
  return { taskId, result: reason };
}

/**
 * Park the Task on an exhausted quota, sleep for a quota window, and wake it — the `park-${round}`
 * branch of the run loop. True when the loop should carry on into another round; false when this
 * run has stood down because the Task left `parked` while it slept (`standDown`).
 */
export async function parkRound(
  scope: RunScope,
  round: number,
  workflowStepId: string | null,
): Promise<boolean> {
  const { step, db, log, workspaceId, taskId, recordTransition, announce } = scope;
  await step.run(`park-${round}`, async () => {
    /*
     * The reason is cleared as the Task parks, and that clearing is load-bearing rather
     * than tidiness.
     *
     * `setTaskState` writes `failureReason` only when it is passed one, so a Task that
     * carried a reason from an earlier round kept it across the park. That made
     * `parked` + a reason ambiguous, and both readers resolved the ambiguity the unsafe
     * way: `heldByRun` reads any reason that is not `STRANDED_PARK_REASON` as a run still
     * sitting in here, so it held for ever, and `reportStrandedParks` selects
     * `isNull(failure_reason)`, so the sweep that would have stamped it never saw the row.
     * Between them the container was unreachable by every path that removes one.
     *
     * Clearing it here rather than relaxing `heldByRun` is the half that is provably safe.
     * A sleeper writes nothing for `PARK_SLEEP_MS`, so a reader that treated any reason as
     * "no run in here" would watch the quiet cushion expire under a perfectly live run and
     * tear its container down — the failure this reaper has already been corrected for
     * once. Writing the row is something only the run does, and at this instant the run is
     * the thing that knows there is no failure outstanding.
     *
     * What remains uncovered is a reason that arrives on an already-`parked` row, which
     * today only an operator can cause. That is their write, not the sleeper's, and
     * guessing at it here would be the same overreach in the other direction.
     */
    await setTaskState(db, workspaceId, taskId, "parked", { failureReason: null });
    await recordTransition("running", "parked", workflowStepId);
  });
  logStateTransition(log, { workspaceId, taskId, from: "running", to: "parked" });
  announce("parked");
  // Resume when the quota window resets. A budget/quota check would refine this.
  await step.sleepUntil(`park-wait-${round}`, new Date(Date.now() + PARK_SLEEP_MS));
  /*
   * Awake — and the row has to say so before this round touches an executor.
   *
   * Nothing else in the orchestrator clears `failureReason` for a `parked` Task, and the
   * resume path at `resume-` below is reached only by a Task that got as far as `review`.
   * The row stays `parked` until `park-claim-` below takes a concurrency slot, and with the
   * Profile full that can be minutes of retries. So a `park_never_resumed` written by
   * `reportStrandedParks`
   * while this run was asleep — an engine backed up past the sweep's window is enough —
   * stayed readable to the container reaper across every gap between durable steps of the
   * round it woke into, and the reaper reads that pairing as "no run is in here". Verified
   * on Docker 29.7.2 what removal costs when it is wrong: `docker rm -f` on a container
   * with a running exec kills it with 137, and `ensureContainer` turns that into an
   * `ExecutorUnavailableError` that fails the round.
   *
   * A durable step of its own, so the write survives a restart between the sleep and the
   * work, and so a replay does not repeat it. It also refreshes `updatedAt`, which is what
   * stops the same sweep reaching the same conclusion again while this round runs.
   *
   * Conditional on the row still reading `parked`, which is the other half of the fix and
   * not a refinement of it. `setTaskState` has no precondition, so writing `parked` here
   * reverted whatever an operator did during the five hours this run was asleep — a Task
   * they finished went back to `parked`, and the `announce` below published the reverted
   * state to the board — after which the row was out of `reclaimOrphanedRuns`' reach (it
   * selects only `running`) and inside `reportStrandedParks`' window. A Task that moved
   * while this run slept is the operator's call, not the sleeper's, so `clearStrandedPark`
   * takes back only the verdict written about the sleep and leaves the state alone.
   *
   * A row that moved is also the end of this run, not just of the write: see `standDown`.
   */
  const stillParked = await step.run(`park-woke-${round}`, () =>
    clearStrandedPark(db, workspaceId, taskId),
  );
  if (!stillParked) return await standDown(scope, round, workflowStepId);
  return await claimWokenSlot(scope, round, workflowStepId);
}

/**
 * End a woken run whose Task left `parked` while it slept, without touching the Task (ADR 0030:
 * one run per Task).
 *
 * Every way out of `parked` belongs to someone else. Retry and a move to Running go through
 * `startTaskRun`, which claims the row and enqueues a *new* run in a fresh Session — carrying on
 * here would be a second harness in the same worktree beside it. A move to Failed, or the Task
 * going to History or being purged, is a person ending the work. None of them expects the
 * sleeper to come back: there is no "resume now" that relies on it.
 *
 * So it writes no state and announces nothing — whoever moved the row has already said what it
 * reads — and holds no slot to give back, because a parked row counts for none. What it does
 * leave is one line in its own Session's log, so that transcript says why it stops where it
 * does. A Session that is gone with its Task has nowhere to say it, and that is not a failure.
 */
async function standDown(
  scope: RunScope,
  round: number,
  workflowStepId: string | null,
): Promise<false> {
  const { step, db, log, workspaceId, taskId, sessionId } = scope;
  await step.run(`park-stood-down-${round}`, async () => {
    try {
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        workflowStepId,
        payload: {
          kind: "notice",
          text: "This run woke from its quota window to find the Task had been moved while it slept, and stood down: whatever moved it owns the Task now.",
        },
      });
    } catch (cause) {
      captureException(log, cause, { stage: "park-stood-down" });
    }
  });
  log.info({ workspaceId, taskId }, "woken park stood down: the Task left parked while it slept");
  return false;
}

/**
 * How long a woken run waits before asking for a slot again: one minute, doubling, at most ten.
 *
 * Short, because a slot is usually freed by a round ending, which is minutes. Bounded, because
 * every attempt is two durable steps and a Profile can stay full for hours: at ten minutes the
 * wait costs a dozen steps an hour, well inside the engine's per-run step budget.
 */
export function slotRetryDelayMs(attempt: number): number {
  return Math.min(60_000 * 2 ** attempt, 10 * 60_000);
}

/**
 * Take a concurrency slot for the round a woken park is about to run (spec F06, FINDINGS F5).
 *
 * A parked Task holds no slot — a sleep of five hours must not keep others of its Profile waiting
 * — so waking has to take one back, under the same rule a person's start does
 * (`claimTaskRunSlot`). A woken round that skipped this ran a full harness while the row read
 * `parked`, which no other start counted: the cap held for everyone except the runs it most
 * exists for, the ones coming back from a quota window together.
 *
 * With the Profile full, the run stays `parked`, says why once, and asks again after a short
 * sleep. Each refusal also refreshes the row through `clearStrandedPark`, so the stranded-park
 * sweep reads a run that is waiting as alive rather than lost.
 *
 * A row that is no longer `parked` by the time a slot is asked for — moved, deleted — makes this
 * run stand down, the same as one found moved on waking.
 */
async function claimWokenSlot(
  scope: RunScope,
  round: number,
  workflowStepId: string | null,
): Promise<boolean> {
  const { deps, step, db, log, workspaceId, taskId, sessionId, channel } = scope;
  const { recordTransition, announce } = scope;
  for (let attempt = 0; ; attempt += 1) {
    const claim = await step.run(`park-claim-${round}-${attempt}`, async () => {
      const claimed = claimTaskRunSlot(db, workspaceId, taskId, ["parked"]);
      if (claimed.kind === "claimed") {
        await recordTransition("parked", "running", workflowStepId);
        return "claimed" as const;
      }
      if (claimed.kind !== "cap_reached") return "moved" as const;
      await clearStrandedPark(db, workspaceId, taskId);
      if (attempt === 0) {
        const payload: SessionEventPayload = {
          kind: "notice",
          text: "The quota window is over, but this Harness Profile is already running as many Tasks as its concurrency cap allows. The Task stays parked and starts as soon as one of them finishes.",
        };
        const seq = await nextSessionEventSeq(db, workspaceId, sessionId);
        await appendSessionEvent(db, workspaceId, { sessionId, seq, workflowStepId, payload });
        const frame = toTaskEvent(payload, taskId, sessionId, seq, workflowStepId);
        if (frame) deps.hub.publish(channel, frame);
      }
      return "full" as const;
    });
    if (claim === "claimed") {
      logStateTransition(log, { workspaceId, taskId, from: "parked", to: "running" });
      announce("running");
      return true;
    }
    if (claim === "moved") return await standDown(scope, round, workflowStepId);
    // Once: it takes a stranded badge off the card, and later refusals change nothing on it.
    if (attempt === 0) announce("parked");
    await step.sleepUntil(
      `park-claim-wait-${round}-${attempt}`,
      new Date(Date.now() + slotRetryDelayMs(attempt)),
    );
  }
}

/**
 * Fail the Task on a round that failed outright — a credential that expired, or a hard failure —
 * with the reason preserved.
 */
export async function failRound(
  scope: RunScope,
  round: number,
  reason: string,
  workflowStepId: string | null,
): Promise<void> {
  const { step, db, log, workspaceId, taskId, recordTransition, announce } = scope;
  await step.run(`fail-${round}`, async () => {
    await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
    await recordTransition("running", "failed", workflowStepId, reason);
  });
  logStateTransition(log, { workspaceId, taskId, from: "running", to: "failed" });
  announce("failed");
  captureException(log, new Error(`task run failed: ${reason}`), { failureReason: reason });
}
