import type { ReviewDecision } from "@solow/contracts";
import { handoffWith } from "@solow/core";
import { clearTaskWorkflowPendingHandoff } from "@solow/db";
import { captureException, logStateTransition } from "@solow/observability";
import {
  appendSessionEvent,
  clearTaskCompletion,
  nextSessionEventSeq,
  setSessionState,
  setTaskState,
  type TaskRepositoryBinding,
  unsatisfiedDependencyIds,
} from "../../../data.js";
import type { Worktree } from "../../../worktree/manager.js";
import { reportStepFinished, type StepTransition, takeAdvance } from "./advance.js";
import { integrateApproval } from "./integration.js";
import type { RunScope } from "./scope.js";
import { failRun } from "./terminal.js";
import type { LoopState, WorktreeBinding, WorktreeOps } from "./types.js";

/*
 * Applying a review decision: the first thing a run started by one does (ADR 0030). A gate is a
 * row in the database; `review.decide` takes it and starts a run carrying the decision, and that
 * run applies it here before any round.
 */

/** The decision a run was started with, as `review.decide` sends it. */
export interface DecidedReview {
  id: string;
  decision: ReviewDecision;
  feedback?: string | null | undefined;
}

/** What applying a decision needs from the run that prepared it. */
export interface DecisionContext {
  /** What moving to the next Step needs, and the Workflow this run resolved. */
  transition: StepTransition;
  /** Git on the Task's own repository, run where the Task runs. */
  worktreeOps: WorktreeOps;
  /** Git on the repositories the deployment shares, run on the orchestrator's host. */
  repoAdmin: WorktreeOps;
  /** Where the primary Repository was prepared. */
  repoPath: string;
  /** The primary worktree an earlier round or Session left on disk, confirmed with git. */
  retainedPrimary: () => Promise<Worktree | null>;
  /** Every worktree this Task has, in attachment order, once the primary one is known. */
  worktreeBindings: (primary: Worktree) => WorktreeBinding[];
  /** Where the deployment holds a Repository. */
  upstreamPathFor: (binding: TaskRepositoryBinding) => string;
}

/**
 * Apply the decision this run was started with, if it was started with one.
 *
 * Everything a decision needs from the round it decides on is read back rather than carried:
 * the harness's declaration from the completion it recorded at the gate, and the worktrees
 * from the rows that say where they are. That is what lets the run that opened a gate end
 * there, and a different run — minutes or days later, after any number of restarts — pick the
 * decision up.
 *
 * Returns a terminal result, or null when the decision sends the harness back to work, in
 * which case the round loop below starts with the state the decision set up.
 */
export async function applyDecision(
  scope: RunScope,
  {
    transition,
    worktreeOps,
    repoAdmin,
    repoPath,
    retainedPrimary,
    worktreeBindings,
    upstreamPathFor,
  }: DecisionContext,
  loop: LoopState,
  decided: DecidedReview,
): Promise<{ taskId: string; result: string } | null> {
  const { step, db, log, workspaceId, taskId, sessionId, ctx, recordTransition, announce } = scope;
  const { wf } = transition;
  const { decision } = decided;
  const feedback = decided.feedback ?? null;
  const summary = ctx.task.completedSummary ?? null;
  const outcome = ctx.task.completedOutcome ?? null;

  if (decision === "request_changes") {
    // Resuming is a *start*, so it is gated on the Task's dependencies exactly as a launch is
    // (issue #6 AC-3). `review.decide` already refuses it before publishing, which makes this
    // a second line rather than the first — but the transition into `running` is applied on
    // this side, and a guard that lives only at the API boundary holds only while the API is
    // the sole producer of decisions.
    const outstanding = await step.run("decision-blockers", () =>
      unsatisfiedDependencyIds(db, workspaceId, taskId),
    );
    if (outstanding.length > 0) {
      const reason = "blocked_by_dependency";
      await step.run("decision-blocked", async () => {
        await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
        await recordTransition("review", "failed", loop.leg.stepId, reason);
      });
      logStateTransition(log, { workspaceId, taskId, from: "review", to: "failed" });
      announce("failed");
      // The blocking ids are Task ids, not content — safe to log, and the only way an
      // operator learns *which* predecessor stopped the resume.
      captureException(log, new Error(`resume refused: ${reason}`), {
        failureReason: reason,
        blockedBy: outstanding,
      });
      return { taskId, result: reason };
    }
    // `""` rather than `undefined` when the reviewer wrote nothing: the next round's brief
    // still has to say the last one was rejected, and only the presence of the field
    // distinguishes a redo from a first attempt.
    loop.pendingFeedback = feedback ?? "";
    await step.run("decision-resume", async () => {
      await setTaskState(db, workspaceId, taskId, "running");
      // The previous round's declaration does not describe the round about to start. Left in
      // place, the board would keep offering to review work being rewritten as you look.
      await clearTaskCompletion(db, workspaceId, taskId);
      await setSessionState(db, workspaceId, sessionId, "active");
      await recordTransition("review", "running", loop.leg.stepId);
    });
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "running" });
    announce("running");
    return null;
  }

  // Approve and reject both act on the work the gate showed, so both need its worktrees —
  // confirmed with git, as a round confirms the one its harness reports, before anything is
  // committed into or discarded from them.
  const known = loop.wt;
  loop.wt = await step.run("decision-worktree", async () =>
    known ? repoAdmin.adopt(repoPath, known.path) : retainedPrimary(),
  );
  if (loop.wt === null) {
    // The directory the decision is about is gone (removed by hand, or past retention).
    // Nothing can be committed or discarded, and saying so beats a `done` with no branch.
    return await failRun(
      scope,
      "decision-worktree-missing",
      "worktree_missing",
      loop.leg.stepId,
      "review",
    );
  }
  const gate = worktreeBindings(loop.wt);

  if (decision === "reject") {
    await step.run("decision-reject", async () => {
      for (const entry of gate) await worktreeOps.discard(entry.worktree.path);
      await setTaskState(db, workspaceId, taskId, "ready");
      await recordTransition("review", "ready", loop.leg.stepId);
    });
    /*
     * A rejection is not a Step completion, so the cursor deliberately does not move — but the
     * rejected attempt still parked its summary in `workflow_pending_handoff`, and that column
     * is promoted into the handoff by whatever eventually completes this Step. Left in place,
     * the work a human explicitly refused becomes the next Step's inbound context.
     *
     * Its own durable step rather than folded into `decision-reject`, which does filesystem
     * work that can throw ahead of it.
     */
    if (wf && loop.leg.stepId) {
      const rejectedStepId = loop.leg.stepId;
      await step.run("decision-reject-handoff", () =>
        clearTaskWorkflowPendingHandoff(db, workspaceId, taskId, rejectedStepId),
      );
    }
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "ready" });
    announce("ready");
    return { taskId, result: "rejected" };
  }

  /*
   * Approved with decisions the reviewer settled: those go back to *this* Step's harness
   * first (see `applyingDecisions`), and the advance happens when it has applied them.
   *
   * The approval's feedback is exactly the settled decisions — the gate sends nothing else
   * with an approval — so its presence is the signal. The decision row is left unspent: the
   * advance at the end of the next round spends it.
   */
  if (wf && loop.leg.stepId && loop.leg.advanceOn && feedback?.trim()) {
    loop.applyingDecisions = feedback.trim();
    const stepId = loop.leg.stepId;
    const stepName = loop.leg.stepName ?? "this step";
    await step.run("decision-apply", async () => {
      await setTaskState(db, workspaceId, taskId, "running");
      await clearTaskCompletion(db, workspaceId, taskId);
      await setSessionState(db, workspaceId, sessionId, "active");
      await recordTransition("review", "running", stepId);
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        workflowStepId: stepId,
        payload: {
          kind: "notice",
          text: `Approved with your decisions. The harness applies them to ${stepName} before the workflow moves on.`,
        },
      });
    });
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "running" });
    announce("running");
    return null;
  }

  /*
   * A human approved, and under a Workflow that is the second of the two facts a Step
   * boundary needs — the harness finished (it recorded its completion at the gate) and a
   * person said yes.
   *
   * `signal: leg.advanceOn`, and **never the literal `"review"`**. A Step that advances on
   * `agent-signal` sitting behind a `human` gate is an ordinary configuration: sending
   * `"review"` to it makes `advanceWorkflowStep` return `held`, the cursor never moves, the
   * approval is never spent, and the pipeline stalls with no error anywhere.
   *
   * `handoff` carries the declaration the harness made at the gate, and the reviewer's words
   * with it; when there is neither, the transaction falls back to `workflow_pending_handoff`.
   */
  if (wf && loop.leg.stepId && loop.leg.advanceOn) {
    const carried = handoffWith(summary, feedback);
    const reported = await reportStepFinished(
      scope,
      wf,
      "decision-advance",
      "decision-advance-recheck",
      {
        fromStepId: loop.leg.stepId,
        signal: loop.leg.advanceOn,
        producedChanges: outcome === "changes_ready",
        ...(carried ? { handoff: carried } : {}),
        ...(outcome ? { outcome } : {}),
      },
    );
    if (reported.kind === "failed") {
      return await failRun(
        scope,
        "decision-advance-failed",
        "workflow_advance_failed",
        loop.leg.stepId,
        "review",
      );
    }
    if (reported.kind === "advanced") {
      const terminal = await takeAdvance(scope, transition, loop, "decision", reported);
      if (terminal) return terminal;
      return null;
    }
    if (reported.status !== "completed") {
      /*
       * Reachable when the `agent-signal` advance already spent this approval: the review
       * that arrives afterwards finds nothing left to spend. Nothing is integrated on any
       * status but `completed`, and the gate is put back so the person can approve again.
       */
      const stepId = loop.leg.stepId;
      await step.run("decision-not-completed", async () => {
        await setTaskState(db, workspaceId, taskId, "review");
        await appendSessionEvent(db, workspaceId, {
          sessionId,
          seq: await nextSessionEventSeq(db, workspaceId, sessionId),
          workflowStepId: stepId,
          payload: {
            kind: "notice",
            text: `This step reported ${reported.status} rather than completing, so nothing was integrated. Approve this step again to move the workflow on.`,
          },
        });
      });
      announce("review");
      return { taskId, result: "workflow_awaiting_decision" };
    }
    // `completed`: the last Step, with a human's approval recorded and now spent. Falls
    // through to the integration below — the one path that integrates.
  }

  return await integrateApproval(scope, {
    gate,
    worktreeOps,
    repoAdmin,
    upstreamPathFor,
    workflowStepId: loop.leg.stepId,
  });
}
