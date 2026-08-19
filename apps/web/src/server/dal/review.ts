import "server-only";
import type { ReviewDecision } from "@gatecontrol/contracts";
import { CommonErrorCode, err, ok, type Result, type ReviewDto } from "@gatecontrol/contracts";
import { review } from "@gatecontrol/db";
import { and, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/** Record a human review decision (Principle I — recorded human approval). */
export async function recordReview(
  ctx: RequestContext,
  input: { sessionId: string; decision: ReviewDecision; feedback?: string | null },
): Promise<Result<ReviewDto>> {
  const [row] = await ctx.db
    .insert(review)
    .values({
      workspaceId: ctx.workspaceId,
      sessionId: input.sessionId,
      decision: input.decision,
      feedback: input.feedback ?? null,
      actorUserId: ctx.userId,
    })
    .returning();
  return row ? ok(row) : err(CommonErrorCode.ValidationFailed);
}

export async function getReviewForSession(
  ctx: RequestContext,
  sessionId: string,
): Promise<Result<ReviewDto | null>> {
  const [row] = await ctx.db
    .select()
    .from(review)
    .where(and(eq(review.workspaceId, ctx.workspaceId), eq(review.sessionId, sessionId)))
    .limit(1);
  return ok(row ?? null);
}
