import type { SessionEventPayload, TaskState } from "@solow/contracts";
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
 * Roughly one quota window; a real budget check would replace the guess rather than tune it.
 *
 * Exported for one reason, and it is not reuse: `reconcile.ts` keeps a second copy of this value
 * (`PARK_WINDOW_MS`) because a sweep that runs every sixty seconds must not import this module and
 * everything it drags in, and that copy decides when a parked run is called lost. The drift has a
 * direction — grow this without growing that, and the sweep starts condemning runs that are still
 * legitimately asleep — so `reconcile.test.ts` pins the two equal, and this export is what lets it.
 */
export const PARK_SLEEP_MS = 5 * 60 * 60 * 1000;

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
 * branch of the run loop. The loop carries on into another round when this returns.
 */
export async function parkRound(
  scope: RunScope,
  round: number,
  workflowStepId: string | null,
): Promise<void> {
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
   * What it does not do is stop this run: the loop carries on into another round against a
   * Task the operator may have called finished. That is the pre-existing shape of a woken
   * park — the run owns the worktree and nothing else can commit it — and narrowing it
   * means deciding what a run should do when its Task is taken out from under it, which is
   * a lifecycle question and not this step's.
   */
  const stillParked = await step.run(`park-woke-${round}`, () =>
    clearStrandedPark(db, workspaceId, taskId),
  );
  // Skipped when the row moved: whoever moved it has already announced what they did.
  if (stillParked) await claimWokenSlot(scope, round, workflowStepId);
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
 * A row that is no longer `parked` (an operator moved it while the run slept) is left alone, and
 * the round goes on as it did before this existed — what a run should do when its Task is taken
 * out from under it is a lifecycle question, not this step's.
 */
async function claimWokenSlot(
  scope: RunScope,
  round: number,
  workflowStepId: string | null,
): Promise<void> {
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
      return;
    }
    if (claim === "moved") return;
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
