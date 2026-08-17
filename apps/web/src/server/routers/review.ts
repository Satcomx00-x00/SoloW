import "server-only";
import { reviewDecisionInput, reviewDto } from "@gatecontrol/contracts";
import { recordReview } from "../dal/review.js";
import { getSessionById, setSessionState } from "../dal/session.js";
import { updateTaskState } from "../dal/task.js";
import { devOwnerMode } from "../env.js";
import { orchestrator } from "../orchestrator-client.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

/** Review → resulting Task state (mirrors the orchestrator's integrate step, plan §9). */
const DECISION_TASK_STATE = {
  approve: "done",
  reject: "ready",
  request_changes: "running",
} as const;

export const reviewRouter = router({
  /**
   * Record a human decision on a Session's diff (Principle I). In a real deployment the
   * orchestrator's durable workflow finalizes the Task (approve → commit + Done; reject →
   * discard; request_changes → resume). In dev-owner mode the durable service isn't running,
   * so the transition is applied here so the local loop is demonstrable end-to-end.
   */
  decide: ownerProcedure
    .meta({ openapi: { method: "POST", path: "/review.decide", tags: ["review"], protect: true } })
    .input(reviewDecisionInput)
    .output(reviewDto)
    .mutation(async ({ ctx, input }) => {
      // Ownership: the Session must belong to this Workspace before we record a decision.
      const session = unwrap(await getSessionById(ctx.rctx, input.sessionId));

      const review = unwrap(
        await recordReview(ctx.rctx, {
          sessionId: input.sessionId,
          decision: input.decision,
          feedback: input.feedback ?? null,
        }),
      );

      // Release the decision to the durable workflow (dev: logs-and-returns).
      await orchestrator.resumeReview({
        workspaceId: ctx.rctx.workspaceId,
        sessionId: input.sessionId,
        decision: input.decision,
        feedback: input.feedback ?? null,
      });

      // Dev stand-in for the orchestrator's integrate step: apply the resulting Task state
      // and close the session on a terminal decision.
      if (devOwnerMode()) {
        const nextState = DECISION_TASK_STATE[input.decision];
        unwrap(await updateTaskState(ctx.rctx, session.taskId, nextState));
        if (input.decision !== "request_changes") {
          await setSessionState(ctx.rctx, input.sessionId, "closed", {
            endedAt: new Date().toISOString(),
          });
        }
      }

      return review;
    }),
});
