import { handoffWith, reopenAfterApplyingDecisions, stepCanEndWorkflow } from "@solow/core";
import { captureException, logStateTransition } from "@solow/observability";
import {
  appendSessionEvent,
  nextSessionEventSeq,
  recordTaskCompletion,
  setSessionState,
  setTaskState,
} from "../../../data.js";
import type { Worktree } from "../../../worktree/manager.js";
import { reportStepFinished, type StepTransition, takeAdvance } from "./advance.js";
import type { runHarnessRound } from "./round.js";
import type { RunScope } from "./scope.js";
import { failRun } from "./terminal.js";
import { type LoopState, patternsFor, type WorktreeBinding, type WorktreeOps } from "./types.js";

/*
 * What a finished round leads to: the declaration and the change recorded, then — under a
 * Workflow — the Step reported finished on its own signal or once a reviewer's settled decisions
 * are applied, and otherwise the gate opened. The run ends at the gate (ADR 0030).
 */

/** A round whose harness finished, as `runHarnessRound` reports it. */
export type FinishedRound = Extract<
  Awaited<ReturnType<typeof runHarnessRound>>,
  { kind: "completed" }
>;

/** What finishing a round needs from the run that prepared it. */
export interface FinishContext {
  /** What moving to the next Step needs, and the Workflow this run resolved. */
  transition: StepTransition;
  /** Git on the Task's own repository, run where the Task runs. */
  worktreeOps: WorktreeOps;
  /** Every worktree this Task has, in attachment order, once the primary one is known. */
  worktreeBindings: (primary: Worktree) => WorktreeBinding[];
}

/**
 * Record a finished round and take it to its gate or to the next Step.
 *
 * Returns the run's terminal result, or null when the loop carries on into another round on the
 * Step the cursor moved to.
 */
export async function finishRound(
  scope: RunScope,
  round: number,
  loop: LoopState,
  run: FinishedRound,
  { transition, worktreeOps, worktreeBindings }: FinishContext,
): Promise<{ taskId: string; result: string } | null> {
  const {
    deps,
    step,
    db,
    log,
    workspaceId,
    taskId,
    sessionId,
    channel,
    recordTransition,
    announce,
  } = scope;
  const { wf } = transition;
  /*
   * The harness has finished. It does not follow that the Task is in review.
   *
   * This step used to move it there itself, which made the review gate something that happened
   * *to* an operator rather than something they opened — and made "the harness stopped" and "the
   * work is ready" the same event, which they are not: a harness stops when it runs out of
   * things to do, when it runs out of context, and when it decides the brief was already
   * satisfied. Only one of those is worth a person's attention, and only the harness knows which.
   *
   * So the run records the declaration and the change, and stops. The Task stays where it is,
   * the board shows it as finished, and the transition into `review` is the operator's click —
   * one action, theirs (Principle I is a gate for a human to open, not a conveyor).
   */
  const worktree = run.worktree;
  const gate = worktreeBindings(worktree);
  await step.run(`to-review-${round}`, async () => {
    await recordTaskCompletion(db, workspaceId, taskId, {
      // `changes_ready` when the harness said nothing: it stopped having produced a run, and the
      // conservative reading is the one that puts the work in front of a person rather than
      // the one that quietly files it as "nothing to see".
      outcome: run.outcome ?? "changes_ready",
      summary: run.summary ?? null,
      at: new Date().toISOString(),
    });
    await setSessionState(db, workspaceId, sessionId, "awaiting_review", {
      diffRef: worktree.branch,
    });

    // Capture the change now, while the worktrees still exist: approving removes them, and a
    // reviewer looking at a finished Task should still be able to see what they approved.
    // A capture failure must not block the review gate — the branch name alone is enough to
    // decide on, so this degrades to "no diff shown" rather than stalling the Task.
    //
    // One event per worktree, each naming its Repository (issue #7 AC-4). A Task spanning two
    // repositories produces two changes on two branches, and a reviewer shown one flat file
    // list could not tell which repository a path came from. One repository failing to capture
    // costs only its own group, not the others'.
    for (const entry of gate) {
      try {
        const captured = await worktreeOps.diff(entry.worktree.path, patternsFor(entry));
        await appendSessionEvent(db, workspaceId, {
          sessionId,
          seq: await nextSessionEventSeq(db, workspaceId, sessionId),
          workflowStepId: loop.leg.stepId,
          payload: {
            kind: "diff",
            diffRef: entry.worktree.branch,
            repositoryId: entry.binding.repository.id,
            repositoryName: entry.binding.repository.name,
            ...captured,
          },
        });
      } catch (cause) {
        captureException(log, cause, { stage: "diff-capture" });
      }
    }

    deps.hub.publish(channel, { kind: "diff", taskId, sessionId, diffRef: worktree.branch });
  });
  // The board still has to hear about it — the card's "finished" control appears on this, and
  // the Task's state has not changed to carry the news for it.
  announce("running");

  /*
   * The harness has finished, and on an `agent-signal` Step that is the signal the Step
   * advances on (AC-2). Reported here, and the placement is load-bearing:
   *
   * **After `to-review-${round}`, never before it.** `to-review` is what writes the `diff`
   * session events, and `taskHasRecordedChanges` corroborates the `producedChanges` claim
   * against exactly those events. Move this call above it and the corroborating scan finds
   * nothing, so an `auto-unless-changes` gate opens on the harness's unverified word about its
   * own output — which is the party the gate exists to catch.
   *
   * **Before the gate,** because an `auto` Step must not need a human at all.
   */
  /*
   * The round that applied a reviewer's decisions has ended: spend the approval it was started
   * by, and move on — unless there is a reason a person has to look again first.
   *
   * Three reasons, each a gate reopened on the same Step rather than an advance:
   *
   * - The harness asked new decisions while applying the old ones. Those are as unconfirmed
   *   as the first ones were, and confirming them is the whole point of the gate.
   * - The harness gave up (`blocked`). There is nothing finished to move on from.
   * - This Step can end the Workflow. Ending it integrates, and integration happens only on an
   *   approval of the work being integrated (Principle I) — this round's work has not been
   *   seen by anyone yet. One more click on the last Step is the price of never committing a
   *   change nobody looked at.
   *
   * `holdForReview` keeps the `agent-signal` advance below from spending the same approval in
   * any of those cases: the decision row the reviewer wrote is still unspent until the cursor
   * moves, so that call would otherwise carry the Step past the gate this block just kept.
   */
  let holdForReview = false;
  if (loop.applyingDecisions !== null) {
    const settled = loop.applyingDecisions;
    loop.applyingDecisions = null;
    const stepId = loop.leg.stepId;
    const canEnd = !wf || !stepId || stepCanEndWorkflow(wf.steps, stepId);
    const reopenBecause = reopenAfterApplyingDecisions({
      askedDecisions: run.askedDecisions,
      outcome: run.outcome,
      canEnd,
    });
    if (wf && stepId && loop.leg.advanceOn && run.outcome !== "blocked" && reopenBecause === null) {
      // What the next Step is briefed with: this round's summary — the work *after* the
      // answers — and the answers themselves, so it is told what was settled either way.
      const carried = handoffWith(run.summary, settled);
      const reported = await reportStepFinished(
        scope,
        wf,
        `workflow-applied-${round}`,
        `workflow-recheck-applied-${round}`,
        {
          fromStepId: stepId,
          signal: loop.leg.advanceOn,
          producedChanges: run.outcome === "changes_ready",
          ...(carried ? { handoff: carried } : {}),
          ...(run.outcome ? { outcome: run.outcome } : {}),
        },
      );
      if (reported.kind === "failed") {
        return await failRun(
          scope,
          `workflow-advance-failed-${round}`,
          "workflow_advance_failed",
          stepId,
          "running",
        );
      }
      if (reported.kind === "advanced") {
        const terminal = await takeAdvance(scope, transition, loop, round, reported);
        if (terminal) return terminal;
        return null;
      }
      // Not advanced by the Step's own rule (`held`, `awaiting-decision`): the gate below
      // opens, which is the conservative reading — nothing moves on without a decision.
      holdForReview = true;
    } else {
      holdForReview = true;
      if (reopenBecause !== null && stepId) {
        await step.run(`decisions-reopened-${round}`, async () => {
          await appendSessionEvent(db, workspaceId, {
            sessionId,
            seq: await nextSessionEventSeq(db, workspaceId, sessionId),
            workflowStepId: stepId,
            payload: {
              kind: "notice",
              text:
                reopenBecause === "new-decisions"
                  ? "Applying your decisions raised new ones. Confirm them, then approve again to move on."
                  : "Your decisions are applied. This step can end the workflow, so nothing is integrated until you approve the result.",
            },
          });
        });
      }
    }
  }

  if (wf && loop.leg.advanceOn === "agent-signal" && loop.leg.stepId && !holdForReview) {
    const reported = await reportStepFinished(
      scope,
      wf,
      `workflow-signal-${round}`,
      `workflow-recheck-${round}`,
      {
        fromStepId: loop.leg.stepId,
        signal: "agent-signal",
        producedChanges: run.outcome === "changes_ready",
        ...(run.summary ? { handoff: run.summary } : {}),
        ...(run.outcome ? { outcome: run.outcome } : {}),
      },
    );
    if (reported.kind === "failed") {
      return await failRun(
        scope,
        `workflow-advance-failed-${round}`,
        "workflow_advance_failed",
        loop.leg.stepId,
        "running",
      );
    }
    if (reported.kind === "advanced") {
      const terminal = await takeAdvance(scope, transition, loop, round, reported);
      if (terminal) return terminal;
      return null;
    }
    /*
     * `completed` here means the *last* Step signalled and an unspent approval was found —
     * and it deliberately does not integrate. Integration keeps exactly one home in this
     * file, inside `decision-approve`, reachable only from a run started by an `approve`
     * decision. Falling through to the gate costs one extra approval in a rare state, which
     * is stricter than Principle I requires and never looser.
     *
     * `awaiting-decision` and `held` fall through for the ordinary reason: the cursor did not
     * move and a person has to look. The Step's summary is parked in
     * `workflow_pending_handoff`, which is the column's whole purpose — the run that
     * applies the decision is a different run, and has only the database to read them from.
     */
  }

  /*
   * Under a Workflow, the run opens the gate itself (F03 FR-10: "when a Run reaches a Gate, it
   * pauses and requests the required human decision").
   *
   * The rule above — the transition into `review` is the operator's click — is about a Task
   * on no Workflow, where "the harness stopped" and "someone should look" are different facts
   * and only the person can tell which. Here they are the same fact: the only way past this
   * point is a decision, so a Task left `running` with an "Open review" button is a
   * gate the person has to open before they can answer it. A plan-first Step showed the cost
   * in full — its harness declares `nothing_to_do` every time, and the operator was left
   * looking at "Finished — nothing to do" with the Approve they needed one click further away.
   *
   * Not for a harness that gave up: `blocked` has not reached the gate, and a review over an
   * abandoned run asks a person to sign off on nothing — the same line `canOpenReview` draws.
   * Idempotent on a redrive: `setTaskState` writes the same value and `recordTransition`
   * drops an identical adjacent transition.
   *
   * `failureReason: null` because a gate this run has just opened is a live one — whatever an
   * earlier round left on the row is overtaken. Kept, a `review_decision_not_applied` from
   * before a Retry made this gate read as dead: the page offered Retry instead of Approve.
   */
  if (wf && loop.leg.stepId && run.outcome !== "blocked") {
    const stepId = loop.leg.stepId;
    await step.run(`open-gate-${round}`, async () => {
      await setTaskState(db, workspaceId, taskId, "review", { failureReason: null });
      await recordTransition("running", "review", stepId);
    });
    logStateTransition(log, { workspaceId, taskId, from: "running", to: "review" });
    announce("review");
  }

  /*
   * The gate is open, and the run ends here.
   *
   * The decision is not waited for. It is a row someone writes later, and `review.decide`
   * starts the next run with it (see `launchData`); that run applies it before anything else.
   * Ending is what makes a decision impossible to lose: there is no parked run to go missing,
   * and the executor this run holds is released instead of sitting idle behind a person.
   */
  return { taskId, result: "awaiting_review" };
}
