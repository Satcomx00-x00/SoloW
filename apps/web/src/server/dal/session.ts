import "server-only";
import {
  CommonErrorCode,
  err,
  ok,
  parseSessionEventPayload,
  type Result,
  type SessionCursorDto,
  SessionErrorCode,
  type SessionEventPayload,
  type SessionState,
  sessionEventPayloadSchema,
} from "@gatecontrol/contracts";
import {
  type SessionLogEvent,
  sessionCursorAt,
  verifySessionCursor,
} from "@gatecontrol/core/session-log";
import { session, sessionEvent, sessionSummary } from "@gatecontrol/db";
import { and, asc, desc, eq, gt, gte, lte } from "drizzle-orm";
import type { RequestContext } from "./context.js";

type SessionRow = typeof session.$inferSelect;
type SessionEventRow = typeof sessionEvent.$inferSelect;

/** A stored event with its payload already read back through the contract union. */
export interface TypedSessionEvent extends Omit<SessionEventRow, "kind" | "payload"> {
  kind: SessionEventPayload["kind"];
  payload: SessionEventPayload;
  /**
   * The payload as the row holds it, before the union read it. Carried so the fork cursor can
   * hash what is stored rather than what was parsed out of it — see `SessionLogEvent.stored`.
   */
  stored: unknown;
}

const typed = (row: SessionEventRow): TypedSessionEvent => {
  const payload = parseSessionEventPayload(row.kind, row.payload);
  return { ...row, kind: payload.kind, payload, stored: row.payload };
};

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

/**
 * Append-only event log (used for streaming + reconnect replay).
 *
 * The payload is validated against the contract union before the insert and the `kind` column is
 * derived from it, so the web app writes exactly the shape the orchestrator does (issue #2,
 * AC-1) — a union enforced on only one of two writers would not be enforced at all.
 */
export async function appendSessionEvent(
  ctx: RequestContext,
  input: { sessionId: string; seq: number; payload: SessionEventPayload },
): Promise<Result<void>> {
  const payload = sessionEventPayloadSchema.parse(input.payload);
  await ctx.db.insert(sessionEvent).values({
    workspaceId: ctx.workspaceId,
    sessionId: input.sessionId,
    seq: input.seq,
    kind: payload.kind,
    payload,
  });
  return ok(undefined);
}

export async function listSessionEvents(
  ctx: RequestContext,
  sessionId: string,
): Promise<Result<TypedSessionEvent[]>> {
  const rows = await ctx.db
    .select()
    .from(sessionEvent)
    .where(
      and(eq(sessionEvent.workspaceId, ctx.workspaceId), eq(sessionEvent.sessionId, sessionId)),
    )
    .orderBy(asc(sessionEvent.seq));
  return ok(rows.map(typed));
}

/**
 * The events inside one closed `[fromSeq, toSeq]` range, oldest first (issue #2, AC-3).
 *
 * What `session.get` leaves out is read back through here, on demand, when an operator expands a
 * summarised range. That is the half of compaction that actually reduces anything: without it a
 * summary is an extra row on top of a response that still carries every event it stands for.
 * Workspace-scoped like every other query (Principle V).
 */
export async function listSessionEventsInRange(
  ctx: RequestContext,
  input: { sessionId: string; fromSeq: number; toSeq: number },
): Promise<Result<TypedSessionEvent[]>> {
  const rows = await ctx.db
    .select()
    .from(sessionEvent)
    .where(
      and(
        eq(sessionEvent.workspaceId, ctx.workspaceId),
        eq(sessionEvent.sessionId, input.sessionId),
        gte(sessionEvent.seq, input.fromSeq),
        lte(sessionEvent.seq, input.toSeq),
      ),
    )
    .orderBy(asc(sessionEvent.seq));
  return ok(rows.map(typed));
}

/** Summaries recorded for a Session, oldest range first. Workspace-scoped (Principle V). */
export async function listSessionSummaries(
  ctx: RequestContext,
  sessionId: string,
): Promise<Result<(typeof sessionSummary.$inferSelect)[]>> {
  const rows = await ctx.db
    .select()
    .from(sessionSummary)
    .where(
      and(eq(sessionSummary.workspaceId, ctx.workspaceId), eq(sessionSummary.sessionId, sessionId)),
    )
    .orderBy(asc(sessionSummary.fromSeq));
  return ok(rows);
}

const logOf = (rows: readonly TypedSessionEvent[]): SessionLogEvent[] =>
  rows.map((r) => ({ seq: r.seq, payload: r.payload, stored: r.stored }));

/**
 * The fork point at `seq` over a log the caller already holds (issue #2, AC-4).
 *
 * Exported beside the query rather than folded into it because `session.get` has just read the
 * whole log for its own reasons: minting from the rows in hand spares that request a second full
 * scan and a second canonical-JSON pass over every payload — including whole `diff` patches — on
 * the one endpoint this issue exists to keep survivable for a long run.
 */
export function sessionCursorOf(
  sessionId: string,
  events: readonly TypedSessionEvent[],
): SessionCursorDto | null {
  return sessionCursorAt(sessionId, logOf(events));
}

/**
 * The fork point at `seq`, or at the head of the log (issue #2, AC-4). `NOT_FOUND` when the log
 * has no such point — an empty Session, or a `seq` nothing ever wrote.
 */
export async function sessionForkCursor(
  ctx: RequestContext,
  sessionId: string,
  seq?: number,
): Promise<Result<SessionCursorDto, typeof CommonErrorCode.NotFound>> {
  const events = unwrapRows(await listSessionEvents(ctx, sessionId));
  const cursor = sessionCursorAt(sessionId, logOf(events), seq);
  return cursor ? ok(cursor) : err(CommonErrorCode.NotFound);
}

/**
 * Everything after a fork point, provided the history behind it has not been rewritten.
 *
 * The refusal is the point (AC-4): a child run resuming from a parent transcript that changed
 * underneath it would continue from a history nobody promised, which is worse than failing.
 */
export async function listSessionEventsFrom(
  ctx: RequestContext,
  cursor: SessionCursorDto,
): Promise<
  Result<TypedSessionEvent[], typeof CommonErrorCode.NotFound | typeof SessionErrorCode.CursorStale>
> {
  const events = unwrapRows(await listSessionEvents(ctx, cursor.sessionId));
  const check = verifySessionCursor(logOf(events), cursor);
  if (!check.ok) {
    return check.error === "cursor_hash_mismatch"
      ? err(SessionErrorCode.CursorStale)
      : err(CommonErrorCode.NotFound);
  }
  const rows = await ctx.db
    .select()
    .from(sessionEvent)
    .where(
      and(
        eq(sessionEvent.workspaceId, ctx.workspaceId),
        eq(sessionEvent.sessionId, cursor.sessionId),
        gt(sessionEvent.seq, cursor.seq),
      ),
    )
    .orderBy(asc(sessionEvent.seq));
  return ok(rows.map(typed));
}

/** `listSessionEvents` cannot fail; this keeps the callers above from pretending otherwise. */
function unwrapRows(result: Result<TypedSessionEvent[]>): TypedSessionEvent[] {
  return result.ok ? result.data : [];
}
