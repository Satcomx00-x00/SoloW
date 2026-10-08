import {
  type HarnessProtocol,
  type SessionEventPayload,
  type TaskCompletionOutcome,
  type TaskState,
  type TaskWorkflowBindingDto,
  type WorkflowAdvanceOn,
  WorkflowErrorCode,
  type WorkflowStepDto,
} from "@solow/contracts";
import { advanceTaskWorkflow, loadTaskWorkflowRun } from "@solow/db";
import {
  appendSessionEvent,
  clearTaskCompletion,
  nextSessionEventSeq,
  readTaskState,
  recordHarnessSessionId,
  setSessionState,
  setTaskState,
} from "../../../data.js";
import type { Executor } from "../../../executor/types.js";
import { clientDirectives } from "../../../harness/client-directives.js";
import { missingHarnessRunnerReason } from "../../../harness/protocols.js";
import { type HarnessLaunchSettings, unsupportedLaunchSettings } from "../../../harness/runners.js";
import { toTaskEvent } from "../../../ws/replay.js";
import type { RunScope } from "./scope.js";
import { failRun } from "./terminal.js";
import type { LegAdvance, LoopState, RunLeg } from "./types.js";

/*
 * Moving through a Workflow: reporting a Step finished, and rebinding the run to the Step the
 * cursor moved to. The rule that decides *whether* it moves lives in `@solow/core`
 * (`advanceWorkflowStep`), applied inside `advanceTaskWorkflow`'s transaction.
 */

/** What taking an advance needs from the run that prepared it. */
export interface StepTransition {
  /** The Workflow as this run resolved it at `workflow-resume`. */
  wf: TaskWorkflowBindingDto | null;
  /** The leg a Step runs, or null when its Profile was not resolved for this run. */
  legForStep: (workflowStep: WorkflowStepDto, brief: string) => RunLeg | null;
  /** Where a Step's checkpoint hook and this process meet. */
  checkpointStore: string;
  /** The executor this Task runs on; the next Step's runner is bound to it. */
  executor: Executor;
}

/**
 * What a Harness Profile asked its harness to be launched with (issue #94).
 *
 * A function of the Profile rather than a constant read of `ctx.harnessProfile`, because under a
 * Workflow the Profile changes at a Step boundary and the launch settings have to change with it
 * — a Step pinned to a planning model must not be launched with the previous Step's pin.
 */
export function launchSettingsFor(leg: RunLeg, checkpointStore: string): HarnessLaunchSettings {
  const profile = leg.harnessProfile;
  const directives = clientDirectives(leg.harnessCatalog.protocol, leg.harnessCatalog.argsTemplate);
  return {
    // The catalog row's `--auto`, for an ACP harness: SoloW answers every permission itself.
    ...(directives.autoApprove ? { autoApprove: true } : {}),
    // The Step's posture wins where it has one, because a Step *is* a harness launch: the same
    // Profile is deliberately used for a `plan` Step and a `bypassPermissions` Step of one
    // pipeline. Null — and every Task on no Workflow, which has no Step — falls back to the
    // Profile, which is why the Profile keeps the field.
    permissionMode: leg.permissionMode ?? profile.permissionMode,
    ...(profile.model ? { model: profile.model } : {}),
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    // The Step's checkpoints, with the per-Task store their hook relays through. Only a Step
    // has any; the store is the Task's, so a second Step's rules answer in the same place.
    ...(leg.checkpoints.length > 0
      ? { checkpoints: { rules: leg.checkpoints, store: checkpointStore } }
      : {}),
    // The catalog row's pin, per leg for the same reason as the Profile: a Step boundary can
    // change which harness runs, and the next one's minimum is its own.
    ...(leg.harnessCatalog.minVersion
      ? {
          version: {
            minimum: leg.harnessCatalog.minVersion,
            harness: leg.harnessCatalog.displayName,
            installHint: leg.harnessCatalog.installHint,
          },
        }
      : {}),
  };
}

/** The sentence a run says about a pinned setting its protocol cannot carry (issue #94 AC-3). */
export function unsupportedLaunchSettingsNotice(
  protocol: HarnessProtocol,
  unsupported: string[],
): string {
  return `This harness profile pins ${unsupported.join(" and ")}, which ${protocol} cannot select. The run used the harness's own choice instead.`;
}

/**
 * Report the current Step finished, and read what the shared transaction decided (AC-2).
 *
 * One implementation for both call sites, and the transaction itself lives in `@solow/db`
 * rather than here: `unspentApproval` and `producedChanges` are the two inputs to a
 * Principle I gate, and a second copy of them on this side is a second copy that drifts.
 *
 * `StaleCursor` is **not** a failure. It means the transaction committed and Inngest then
 * retried this body from the top — the durable step's own replay hazard, which is why
 * `advanceTaskWorkflow` takes a `fromStepId` at all. The cursor is re-read and a cursor that
 * has moved past the Step we named is reported as the advance it was. Treating it as an error
 * would turn every retried approve into a failed Task.
 */
export async function reportStepFinished(
  scope: RunScope,
  /** The Workflow as this run resolved it at `workflow-resume`. */
  wf: TaskWorkflowBindingDto | null,
  id: string,
  recheckId: string,
  input: {
    fromStepId: string;
    signal: WorkflowAdvanceOn;
    producedChanges: boolean;
    handoff?: string;
    outcome?: TaskCompletionOutcome;
  },
): Promise<LegAdvance> {
  const { deps, step, db, workspaceId, taskId, sessionId, channel } = scope;
  // `call: id` is the durable step's own name, and it is what lets the terminal Step tell a
  // re-run of *this* call apart from the other call site asking for a second gate. See
  // `advanceTaskWorkflowInput.call`.
  //
  // The decision is written into the Session log inside the same durable step as the advance
  // that made it, from the explanation that advance returned — so the record and the cursor
  // cannot disagree, and a replayed step body (memoized) writes it exactly once.
  const reported = await step.run(id, async () => {
    const result = await advanceTaskWorkflow(db, workspaceId, { taskId, call: id, ...input });
    if (!result.ok) return result;
    const nameOf = (stepId: string | null) =>
      stepId === null ? null : (wf?.steps.find((s) => s.id === stepId)?.name ?? stepId);
    const advanced = result.data.status === "advanced";
    const payload: SessionEventPayload = {
      kind: "workflow_decision",
      stepId: input.fromStepId,
      stepName: nameOf(input.fromStepId) ?? input.fromStepId,
      signal: input.signal,
      gate: result.data.explanation.gate,
      needsApproval: result.data.explanation.needsApproval,
      // Why a person is asked, when one is — the gate, the harness's `REVIEW:`, decisions it
      // asked, or a review forced for this Task — so the record says which.
      ...(result.data.explanation.reviewReason
        ? { reviewReason: result.data.explanation.reviewReason }
        : {}),
      condition: result.data.explanation.condition,
      status: result.data.status,
      nextStepId: advanced ? result.data.currentStepId : null,
      nextStepName: advanced ? nameOf(result.data.currentStepId) : null,
      outcome: input.outcome ?? null,
      // The fact the rule read — the claim, corroborated — not the claim as it was sent.
      producedChanges: result.data.explanation.producedChanges,
    };
    const seq = await nextSessionEventSeq(db, workspaceId, sessionId);
    // The Step the decision is *about* — the one being finished — never the one it advances
    // to. A decision filed under the next Step would open that Step's transcript with the
    // verdict on work its reader has not been shown, and the previous Step's would end
    // without saying how it ended. `nextStepId` in the payload is where the onward move is
    // recorded; this column is where the event belongs.
    await appendSessionEvent(db, workspaceId, {
      sessionId,
      seq,
      workflowStepId: input.fromStepId,
      payload,
    });
    const frame = toTaskEvent(payload, taskId, sessionId, seq, input.fromStepId);
    if (frame) deps.hub.publish(channel, frame);
    return result;
  });
  if (reported.ok) {
    return reported.data.status === "advanced"
      ? { kind: "advanced", stepId: reported.data.currentStepId, brief: reported.data.brief }
      : { kind: "status", status: reported.data.status };
  }
  if (reported.error !== WorkflowErrorCode.StaleCursor) return { kind: "failed" };
  const recheck = await step.run(recheckId, () => loadTaskWorkflowRun(db, workspaceId, taskId));
  if (!recheck.ok) return { kind: "failed" };
  // The cursor still naming the Step we tried to finish is the one shape the recheck cannot
  // explain — some other writer moved it back. `held` sends the round to the review gate,
  // which is the conservative reading: nothing integrates without a decision either way.
  return recheck.data.currentStep.id === input.fromStepId
    ? { kind: "status", status: "held" }
    : { kind: "advanced", stepId: recheck.data.currentStep.id, brief: recheck.data.brief };
}

/**
 * Take the advance: rebind the harness, clear what belonged to the finished Step, carry on
 * (AC-2 — "advance to the next Step WITHOUT starting a new Task").
 *
 * Physically that means: no commit, no publish, no result branch, no `done`, no cleanup and
 * no second Task. The worktrees are deliberately kept, because the next Step continues in
 * them — `resuming` in the run body already runs every round after the first inside the
 * primary worktree, so Step 2 sees Step 1's uncommitted work with no new mechanism. Ending
 * the run and re-emitting `task.launch.requested` was the alternative and it destroys that
 * work: the `finally` disposes the executor and `cleanup` removes every worktree.
 *
 * Returns a terminal result when the run cannot go on, and null when the loop continues.
 */
export async function takeAdvance(
  scope: RunScope,
  { wf, legForStep, checkpointStore, executor }: StepTransition,
  loop: LoopState,
  round: number | "decision",
  next: { stepId: string; brief: string },
): Promise<{ taskId: string; result: string } | null> {
  const { deps, step, db, workspaceId, taskId, sessionId, recordTransition, announce } = scope;
  const landed = wf?.steps.find((entry) => entry.id === next.stepId);
  const nextLeg = landed ? legForStep(landed, next.brief) : null;
  if (!nextLeg) {
    /*
     * The cursor landed on a Step this run has never seen — a Step inserted into the
     * definition while the run was live. The advance itself already committed, so nothing is
     * lost by stopping: relaunching the Task reads the definition afresh and resumes on the
     * new cursor. Binding it here is what is impossible, because the Step's Harness Profile was
     * not in the set `workflow-agents` resolved and the pre-clone probe never saw its binary.
     *
     * This is the *only* thing drift costs a durable run. The step ids carry no Step ordinal,
     * so an edit cannot invalidate a memo, and there is deliberately no drift refusal at entry.
     */
    // The Step being left, not the one the cursor landed on: binding that Step is exactly
    // what this run could not do, so filing the failure under its id would put the record in
    // a transcript that is otherwise empty.
    return await failRun(
      scope,
      `workflow-step-unknown-${round}`,
      "workflow_step_unknown",
      loop.leg.stepId,
      "running",
    );
  }
  const rebuiltRunner = deps.runner(
    nextLeg.harnessCatalog.protocol,
    launchSettingsFor(nextLeg, checkpointStore),
    executor,
  );
  if (!rebuiltRunner) {
    // Unreachable through the pre-clone gate, which checked `hasHarnessRunner` for every Step —
    // but `hasHarnessRunner` is the contracts' claim and this call is the fact, so the two are
    // allowed to disagree here rather than in a null dereference three lines on.
    return await failRun(
      scope,
      `workflow-runner-missing-${round}`,
      missingHarnessRunnerReason(nextLeg.harnessCatalog.protocol),
      nextLeg.stepId,
      "running",
    );
  }

  const stateNow = await step.run(`workflow-advanced-${round}`, async () => {
    // Step N's declaration must not linger on Step N+1's card: the board would keep offering
    // to review a summary describing work that is now the *previous* Step's.
    await clearTaskCompletion(db, workspaceId, taskId);
    // A Step that advanced is not awaiting review, whatever `to-review` left behind.
    await setSessionState(db, workspaceId, sessionId, "active");
    /*
     * And Step N's *conversation* must not be offered to Step N+1's harness.
     *
     * One Session spans the whole pipeline, so `harness_session_id` still names the
     * conversation the previous Step was having — different work, briefed differently, often
     * on a different protocol under a different Profile. A round that resumes is a round that
     * is sent a continuation instruction *instead of* a brief, so carrying the id across a
     * Step boundary is how Step 2's harness would never hear what Step 2 asks of it. Cleared
     * for the same reason and in the same breath as the declaration above.
     */
    await recordHarnessSessionId(db, workspaceId, sessionId, null);
    // Read, never assumed from `ctx.task.state`. `to-review` deliberately does not move the
    // Task into `review`, so at an agent-signal advance the row is usually still `running`
    // and no transition is due — writing one anyway would put a `review → running` pair in
    // the log for a review that never happened. An advance a decision made is the exception:
    // the gate it decided was `review`, though `review.decide` has already taken the row.
    const state = round === "decision" ? "review" : await readTaskState(db, workspaceId, taskId);
    if (state === "review") {
      await setTaskState(db, workspaceId, taskId, "running");
      // The Step being entered, not the one just finished: this transition is the first
      // thing the new Step's transcript has to say for itself.
      await recordTransition("review", "running", nextLeg.stepId, "workflow_step_advanced");
      return "running" as TaskState;
    }
    return (state ?? "running") as TaskState;
  });
  announce(stateNow);

  // The new Step's Profile may pin something its protocol cannot carry, and a setting that
  // cannot be honoured is said rather than dropped (issue #94 AC-3). Under the round-scoped
  // id, so the bare one stays exactly what a Task with no Workflow emits.
  const legUnsupported = unsupportedLaunchSettings(
    nextLeg.harnessCatalog.protocol,
    launchSettingsFor(nextLeg, checkpointStore),
  );
  if (legUnsupported.length > 0) {
    await step.run(`launch-settings-unsupported-${round}`, async () => {
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        workflowStepId: nextLeg.stepId,
        payload: {
          kind: "notice",
          text: unsupportedLaunchSettingsNotice(nextLeg.harnessCatalog.protocol, legUnsupported),
        },
      });
    });
  }

  loop.leg = nextLeg;
  loop.runner = rebuiltRunner;
  loop.roundsOnStep = 0;
  loop.autoContinues = 0;
  loop.continuingTruncated = false;
  // The previous Step's review feedback is not the next Step's brief. Left set, Step 2 would
  // open with "your previous attempt was not accepted" about work it did not do.
  loop.pendingFeedback = undefined;
  loop.applyingDecisions = null;
  return null;
}
