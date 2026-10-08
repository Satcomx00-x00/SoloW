import "server-only";
import { ReviewErrorCode, reviewDecisionInput, reviewDto } from "@solow/contracts";
import { TRPCError } from "@trpc/server";
import { forgetReview, recordReview } from "../dal/review.js";
import { getSessionById, setSessionState } from "../dal/session.js";
import { claimTaskState, getTaskById, updateTaskState } from "../dal/task.js";
import { orchestrator } from "../orchestrator-client.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";
import { requireUnblocked } from "./task.js";

export const reviewRouter = router({
  /**
   * Record a human decision on a Session's diff (Principle I) and start the run that applies it:
   * approve → commit (or move the Workflow on), reject → discard, request_changes → another round
   * with the feedback.
   *
   * The gate is a database state, not a run waiting somewhere. Taking the decision is one
   * conditional write — `review` → `running` — so a second click or a second tab finds the Task
   * already gone from the gate and is refused, rather than starting a second run on the same
   * worktree. The run is then started with the decision in its event; if that cannot happen, the
   * gate is put back exactly as it was and the person is told.
   */
  decide: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/review.decide",
        tags: ["review"],
        protect: true,
        summary:
          "Record the human decision on a Session's diff: approve (commit), reject (discard), or request_changes (resume the harness with feedback). This is the review gate — nothing is integrated without it.",
      },
    })
    .input(reviewDecisionInput)
    .output(reviewDto)
    .mutation(async ({ ctx, input }) => {
      // Ownership: the Session must belong to this Workspace before we record a decision.
      const session = unwrap(await getSessionById(ctx.rctx, input.sessionId));
      const current = unwrap(await getTaskById(ctx.rctx, session.taskId));
      // A decision is only taken at the gate. Refused before anything is recorded.
      if (current.state !== "review") {
        throw new TRPCError({ code: "CONFLICT", message: ReviewErrorCode.NotInReview });
      }

      // `request_changes` resumes the harness, so it is a start (issue #6 AC-3), and a blocked
      // Task is refused it with the same code `task.move` uses — here and over MCP alike.
      if (input.decision === "request_changes") {
        await requireUnblocked(ctx.rctx, session.taskId);
      }

      // Without an orchestrator nothing can integrate or run a harness. Reject alone is pure
      // state — back to `ready`, no claim that anything happened to the work — so it is the one
      // decision applied here; the others are refused rather than recorded as if they had been.
      if (!orchestrator.isWired()) {
        if (input.decision !== "reject") {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: ReviewErrorCode.NoOrchestrator,
          });
        }
        const recorded = unwrap(
          await recordReview(ctx.rctx, {
            sessionId: input.sessionId,
            decision: input.decision,
            feedback: input.feedback ?? null,
          }),
        );
        unwrap(await updateTaskState(ctx.rctx, session.taskId, "ready"));
        await setSessionState(ctx.rctx, input.sessionId, "closed", {
          endedAt: new Date().toISOString(),
        });
        return recorded;
      }

      // Take the gate. Whoever loses this write decided on a gate that is no longer open.
      const claimed = await claimTaskState(ctx.rctx, session.taskId, ["review"], "running");
      if (!claimed.ok) {
        throw new TRPCError({ code: "CONFLICT", message: ReviewErrorCode.NotInReview });
      }
      // The Session is live again: a run is about to work in it. Left `awaiting_review`, a run
      // that died before it got going would leave a `running` Task the reconcile sweep reads as
      // waiting for a person, and nothing would ever bring it back to a gate.
      await setSessionState(ctx.rctx, input.sessionId, "active");

      const review = unwrap(
        await recordReview(ctx.rctx, {
          sessionId: input.sessionId,
          decision: input.decision,
          feedback: input.feedback ?? null,
        }),
      );
      try {
        await orchestrator.applyReview({
          workspaceId: ctx.rctx.workspaceId,
          taskId: session.taskId,
          sessionId: input.sessionId,
          review: { id: review.id, decision: review.decision, feedback: review.feedback },
        });
      } catch (cause) {
        // No run will apply it, so it was not taken: the gate goes back to exactly what it was,
        // and the row is forgotten rather than left to read as a decision somebody made and
        // nothing honoured.
        await forgetReview(ctx.rctx, review.id);
        await setSessionState(ctx.rctx, input.sessionId, session.state);
        await updateTaskState(ctx.rctx, session.taskId, "review", {
          failureReason: current.failureReason ?? null,
        });
        throw cause;
      }

      await orchestrator.announceTask({
        workspaceId: ctx.rctx.workspaceId,
        taskId: session.taskId,
        state: "running",
      });
      return review;
    }),
});
