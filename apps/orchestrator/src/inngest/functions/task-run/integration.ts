import { DELIVERY_FAILED_REASON, PARTIAL_INTEGRATION_REASON } from "@solow/core";
import { captureException, logStateTransition } from "@solow/observability";
import {
  appendSessionEvent,
  nextSessionEventSeq,
  setSessionState,
  setTaskRepositoryResultBranch,
  setTaskState,
  type TaskRepositoryBinding,
} from "../../../data.js";
import {
  changeRequestBody,
  deliveryFailedNotice,
  partialIntegrationNotice,
  shipAttachment,
  shippedNotice,
} from "../../../delivery.js";
import type { RunScope } from "./scope.js";
import { patternsFor, type WorktreeBinding, type WorktreeOps } from "./types.js";

/**
 * Integration: what an approval that ends the Task does with the work (Principle I — the one
 * path in the run engine that integrates).
 *
 * Every worktree the gate showed is committed, published where a reviewer can reach it, recorded
 * as the attachment's result branch, and shipped to its remote when it has one (A1). Reached only
 * from a run started by an `approve` decision, once any Workflow has reported the Task complete.
 */
export async function integrateApproval(
  scope: RunScope,
  {
    gate,
    worktreeOps,
    repoAdmin,
    upstreamPathFor,
    workflowStepId,
  }: {
    /** The worktrees the gate showed, confirmed with git. */
    gate: WorktreeBinding[];
    /** Git on the Task's own repository, run where the Task runs. */
    worktreeOps: WorktreeOps;
    /** Git on the repositories the deployment shares, run on the orchestrator's host. */
    repoAdmin: WorktreeOps;
    /** Where the deployment holds a Repository, which the approved branch is published into. */
    upstreamPathFor: (binding: TaskRepositoryBinding) => string;
    /** The Workflow Step being approved, or null for a Task on no Workflow. */
    workflowStepId: string | null;
  },
): Promise<{ taskId: string; result: string }> {
  const { step, db, log, workspaceId, taskId, sessionId, ctx, recordTransition, announce } = scope;
  const integration = await step.run("decision-approve", async () => {
    // One commit per worktree, and each attachment records the branch its own change landed
    // on: a single column on `task` could only ever name one of the branches a reviewer would
    // then need to fetch (issue #7 AC-4).
    //
    // A worktree the harness never touched is skipped rather than committed: `git commit`
    // with nothing staged exits non-zero, which would fail the approve for the repository the
    // harness *did* change. The branch is still recorded, because it exists.
    //
    // Each group is integrated **inside its own try** (issue #70 AC-4). One decision covers
    // the whole Task, so a failure part-way through leaves it partially integrated, and
    // letting the step throw would report that as "the approve failed" — then Inngest would
    // retry it, committing a second time to the branches that already took.
    const integrated: string[] = [];
    const failed: { branch: string; error: string }[] = [];
    /** Requests opened or refreshed, and branches committed but not shipped (A1). */
    const delivered: string[] = [];
    const undelivered: { branch: string; error: string }[] = [];
    for (const entry of gate) {
      try {
        if (await worktreeOps.hasChanges(entry.worktree.path, patternsFor(entry))) {
          await worktreeOps.commit(
            entry.worktree.path,
            `SoloW: task ${taskId}`,
            patternsFor(entry),
          );
        }
        // Then put the branch where a reviewer can reach it (issue #96 round 2): a Task with
        // its own clone committed into that clone, which is torn down with its worktree. A
        // no-op for a local run, whose branch is already in the Repository.
        await repoAdmin.publish(
          entry.worktree.repoPath,
          upstreamPathFor(entry.binding),
          entry.worktree.branch,
        );
        await setTaskRepositoryResultBranch(
          db,
          workspaceId,
          entry.binding.attachment.id,
          entry.worktree.branch,
        );
        integrated.push(entry.worktree.branch);
      } catch (cause) {
        failed.push({
          branch: entry.worktree.branch,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        continue;
      }
      /*
       * Then ship it (A1). Separate from the commit's try so that a refused push is told apart
       * from a failed commit: the branch is committed and recorded either way, and what to do
       * about it differs. A Repository with no remote falls through as a local commit.
       */
      const shipped = await shipAttachment(db, workspaceId, {
        binding: entry.binding,
        branch: entry.worktree.branch,
        title: ctx.issue.title,
        body: changeRequestBody(taskId, ctx.issue.description),
        push: (remoteUrl, credential) =>
          repoAdmin.push(
            upstreamPathFor(entry.binding),
            remoteUrl,
            entry.worktree.branch,
            credential,
          ),
        report: (cause) => captureException(log, cause, { stage: "delivery" }),
      });
      if (shipped.kind === "shipped") delivered.push(shipped.line);
      if (shipped.kind === "failed") undelivered.push(shipped);
    }

    if (failed.length > 0) {
      // Fail loudly, with the partial state named — in the session log, where the reviewer
      // who has to decide what to do about a half-landed change is already looking.
      // `failureReason` stays a class the board can match on.
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        workflowStepId: workflowStepId,
        payload: {
          kind: "notice",
          text: partialIntegrationNotice({ integrated, failed, delivered, undelivered }),
        },
      });
      await setTaskState(db, workspaceId, taskId, "failed", {
        failureReason: PARTIAL_INTEGRATION_REASON,
      });
      await recordTransition("review", "failed", workflowStepId, PARTIAL_INTEGRATION_REASON);
      await setSessionState(db, workspaceId, sessionId, "closed", {
        endedAt: new Date().toISOString(),
      });
      return { integrated, failed, undelivered };
    }

    if (undelivered.length > 0) {
      /*
       * Committed, approved, and not shipped (A1). Never `done`: a Task that says it shipped
       * when the remote has nothing is the failure this feature exists to remove. Failed, with
       * its own reason and the cause in words, so the approval is visibly unfinished instead
       * of silently dropped. Ship again (`redelivery.ts`) pushes the committed branch and
       * finds the same request; Keep local accepts the commit as the result.
       */
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        workflowStepId: workflowStepId,
        payload: {
          kind: "notice",
          text: deliveryFailedNotice({ undelivered, delivered }),
        },
      });
      await setTaskState(db, workspaceId, taskId, "failed", {
        failureReason: DELIVERY_FAILED_REASON,
      });
      await recordTransition("review", "failed", workflowStepId, DELIVERY_FAILED_REASON);
      await setSessionState(db, workspaceId, sessionId, "closed", {
        endedAt: new Date().toISOString(),
      });
      return { integrated, failed, undelivered };
    }

    if (delivered.length > 0) {
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        workflowStepId: workflowStepId,
        payload: { kind: "notice", text: shippedNotice(delivered) },
      });
    }

    await setTaskState(db, workspaceId, taskId, "done");
    await recordTransition("review", "done", workflowStepId);
    // `resumable`, not `closed` (F11 FR-3/FR-5): the worktrees stay on disk for the retention
    // window and the harness conversation with them, so a reopened Task can carry on where
    // this one stopped. The retention sweep closes the Session when it takes the worktree.
    await setSessionState(db, workspaceId, sessionId, "resumable", {
      endedAt: new Date().toISOString(),
    });
    return { integrated, failed, undelivered };
  });

  if (integration.failed.length === 0 && integration.undelivered.length > 0) {
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "failed" });
    captureException(
      log,
      new Error(`delivery failed: ${integration.undelivered.length} branch(es)`),
      {
        failureReason: DELIVERY_FAILED_REASON,
        notDelivered: integration.undelivered.map((u) => u.branch),
      },
    );
    announce("failed");
    return { taskId, result: DELIVERY_FAILED_REASON };
  }

  if (integration.failed.length > 0) {
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "failed" });
    // Branch names, not diff content — safe to log, and the only way an operator learns
    // which half of a partially-integrated Task landed without opening the session.
    captureException(log, new Error(`partial integration: ${integration.failed.length} failed`), {
      failureReason: PARTIAL_INTEGRATION_REASON,
      integrated: integration.integrated,
      notIntegrated: integration.failed.map((f) => f.branch),
    });
    announce("failed");
    return { taskId, result: PARTIAL_INTEGRATION_REASON };
  }
  logStateTransition(log, { workspaceId, taskId, from: "review", to: "done" });
  announce("done");
  return { taskId, result: "done" };
}
