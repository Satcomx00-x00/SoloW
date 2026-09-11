import "server-only";
import type { ReviewDecision } from "@solow/contracts";
import { CommonErrorCode, err, ok, type Result, type ReviewDto } from "@solow/contracts";
import { review } from "@solow/db";
import { and, asc, desc, eq } from "drizzle-orm";
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

/**
 * The latest decision on a Session.
 *
 * A Session accrues one review per round, so "the" review is the newest — this used to read the
 * first row the database happened to return, which on a Session with two rounds was whichever.
 */
export async function getReviewForSession(
  ctx: RequestContext,
  sessionId: string,
): Promise<Result<ReviewDto | null>> {
  const [row] = await ctx.db
    .select()
    .from(review)
    .where(and(eq(review.workspaceId, ctx.workspaceId), eq(review.sessionId, sessionId)))
    .orderBy(desc(review.createdAt), desc(review.id))
    .limit(1);
  return ok(row ?? null);
}

/** Every decision on a Session, oldest first — one per round, in the order the rounds happened. */
export async function listReviewsForSession(
  ctx: RequestContext,
  sessionId: string,
): Promise<Result<ReviewDto[]>> {
  const rows = await ctx.db
    .select()
    .from(review)
    .where(and(eq(review.workspaceId, ctx.workspaceId), eq(review.sessionId, sessionId)))
    .orderBy(asc(review.createdAt), asc(review.id));
  return ok(rows);
}
