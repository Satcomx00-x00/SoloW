import "server-only";
import { CommonErrorCode, err, ok, type Result, type SessionState } from "@gatecontrol/contracts";
import { session, sessionEvent } from "@gatecontrol/db";
import { and, asc, desc, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";

type SessionRow = typeof session.$inferSelect;
type SessionEventRow = typeof sessionEvent.$inferSelect;

export async function createSession(
  ctx: RequestContext,
  taskId: string,
): Promise<Result<SessionRow>> {
  const [row] = await ctx.db
    .insert(session)
    .values({ workspaceId: ctx.workspaceId, taskId, state: "active" })
    .returning();
  return row ? ok(row) : err(CommonErrorCode.ValidationFailed);
}

export async function getLatestSession(
  ctx: RequestContext,
  taskId: string,
): Promise<Result<SessionRow, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(session)
    .where(and(eq(session.workspaceId, ctx.workspaceId), eq(session.taskId, taskId)))
    .orderBy(desc(session.startedAt))
    .limit(1);
  return row ? ok(row) : err(CommonErrorCode.NotFound);
}

/** List a Task's Sessions, newest first (scoped to the Workspace). */
export async function listSessionsForTask(
  ctx: RequestContext,
  taskId: string,
): Promise<Result<SessionRow[]>> {
  const rows = await ctx.db
    .select()
    .from(session)
    .where(and(eq(session.workspaceId, ctx.workspaceId), eq(session.taskId, taskId)))
    .orderBy(desc(session.startedAt));
  return ok(rows);
}

/** Fetch a Session by id, scoped to the Workspace (ownership check). */
export async function getSessionById(
  ctx: RequestContext,
  id: string,
): Promise<Result<SessionRow, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(session)
    .where(and(eq(session.workspaceId, ctx.workspaceId), eq(session.id, id)))
    .limit(1);
  return row ? ok(row) : err(CommonErrorCode.NotFound);
}

export async function setSessionState(
  ctx: RequestContext,
  id: string,
  state: SessionState,
  extra?: { diffRef?: string; endedAt?: string },
): Promise<Result<SessionRow, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(session)
    .set({
      state,
      ...(extra?.diffRef !== undefined ? { diffRef: extra.diffRef } : {}),
      ...(extra?.endedAt !== undefined ? { endedAt: extra.endedAt } : {}),
    })
    .where(and(eq(session.workspaceId, ctx.workspaceId), eq(session.id, id)))
    .returning();
  return row ? ok(row) : err(CommonErrorCode.NotFound);
}

/** Append-only event log (used for streaming + reconnect replay). */
export async function appendSessionEvent(
  ctx: RequestContext,
  input: { sessionId: string; seq: number; kind: string; payload: unknown },
): Promise<Result<void>> {
  await ctx.db.insert(sessionEvent).values({
    workspaceId: ctx.workspaceId,
    sessionId: input.sessionId,
    seq: input.seq,
    kind: input.kind,
    payload: input.payload,
  });
  return ok(undefined);
}

export async function listSessionEvents(
  ctx: RequestContext,
  sessionId: string,
): Promise<Result<SessionEventRow[]>> {
  const rows = await ctx.db
    .select()
    .from(sessionEvent)
    .where(
      and(eq(sessionEvent.workspaceId, ctx.workspaceId), eq(sessionEvent.sessionId, sessionId)),
    )
    .orderBy(asc(sessionEvent.seq));
  return ok(rows);
}
