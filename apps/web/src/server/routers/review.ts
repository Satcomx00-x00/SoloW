import "server-only";
import { TRPCError } from "@trpc/server";
import { CommonErrorCode, reviewDecisionInput } from "@gatecontrol/contracts";
import { ownerProcedure, router, unwrap } from "../trpc.js";
import { recordReview } from "../dal/review.js";
import { getSessionById } from "../dal/session.js";
import { orchestrator } from "../orchestrator-client.js";

export const reviewRouter = router({
  /**
   * Record a human decision on a Session's diff (Principle I). The Task is finalized by
   * the orchestrator's durable workflow once the decision is released (plan §9): approve →
   * commit + Done; reject → discard; request_changes → resume the agent.
   */
  decide: ownerProcedure.input(reviewDecisionInput).mutation(async ({ ctx, input }) => {
    // Ownership: the Session must belong to this Workspace before we record a decision.
    unwrap(await getSessionById(ctx.rctx, input.sessionId));

    const review = unwrap(
      await recordReview(ctx.rctx, {
        sessionId: input.sessionId,
        decision: input.decision,
        feedback: input.feedback ?? null,
      }),
    );

    try {
      await orchestrator.resumeReview({
        workspaceId: ctx.rctx.workspaceId,
        sessionId: input.sessionId,
        decision: input.decision,
        feedback: input.feedback ?? null,
      });
    } catch {
      // Orchestrator not wired yet (Phase 3); the review is recorded and will be picked
      // up once the workflow is live.
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: `${CommonErrorCode.ValidationFailed}: orchestrator resume not wired (Phase 3)`,
      });
    }

    return review;
  }),
});
