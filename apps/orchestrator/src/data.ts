import type { SessionState, TaskState } from "@gatecontrol/contracts";
import {
  agentCatalog,
  agentProfile,
  type Db,
  issue,
  repository,
  secret,
  session,
  sessionEvent,
  sessionUsage,
  task,
} from "@gatecontrol/db";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";

/**
 * Orchestrator-side data access. Scoped by workspaceId (the tenant key travels on the
 * launch event, originating from the authenticated session that created it — Principle V).
 * Kept separate from the web DAL, which is `server-only` and request-context bound.
 */

export interface TaskRunContext {
  task: typeof task.$inferSelect;
  /** The Issue the Task belongs to — its description is the agent's brief. */
  issue: typeof issue.$inferSelect;
  agentProfile: typeof agentProfile.$inferSelect;
  /** Which agent this Profile runs, and how — launch command and billing variables (#10). */
  agentCatalog: typeof agentCatalog.$inferSelect;
  repository: typeof repository.$inferSelect;
  secretCiphertext: string | null;
}

export async function loadTaskRunContext(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<TaskRunContext> {
  const [t] = await db
    .select()
    .from(task)
    .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId)))
    .limit(1);
  if (!t) throw new Error(`task ${taskId} not found in workspace ${workspaceId}`);

  const [iss] = await db
    .select()
    .from(issue)
    .where(and(eq(issue.workspaceId, workspaceId), eq(issue.id, t.issueId)))
    .limit(1);
  if (!iss) throw new Error(`issue ${t.issueId} not found`);

  const [ap] = await db
    .select()
    .from(agentProfile)
    .where(and(eq(agentProfile.workspaceId, workspaceId), eq(agentProfile.id, t.agentProfileId)))
    .limit(1);
  if (!ap) throw new Error(`agent profile ${t.agentProfileId} not found`);

  const [cat] = await db
    .select()
    .from(agentCatalog)
    .where(and(eq(agentCatalog.workspaceId, workspaceId), eq(agentCatalog.id, ap.agentCatalogId)))
    .limit(1);
  if (!cat) throw new Error(`agent catalog entry ${ap.agentCatalogId} not found`);

  const [repo] = await db
    .select()
    .from(repository)
    .where(and(eq(repository.workspaceId, workspaceId), eq(repository.id, t.repositoryId)))
    .limit(1);
  if (!repo) throw new Error(`repository ${t.repositoryId} not found`);

  const [sec] = await db
    .select({ ciphertext: secret.ciphertext })
    .from(secret)
    .where(and(eq(secret.workspaceId, workspaceId), eq(secret.id, ap.secretId)))
    .limit(1);

  return {
    task: t,
    issue: iss,
    agentProfile: ap,
    agentCatalog: cat,
    repository: repo,
    secretCiphertext: sec?.ciphertext ?? null,
  };
}

export async function setTaskState(
  db: Db,
  workspaceId: string,
  taskId: string,
  state: TaskState,
  extra?: { resultBranch?: string; failureReason?: string | null },
): Promise<void> {
  await db
    .update(task)
    .set({
      state,
      ...(extra?.resultBranch !== undefined ? { resultBranch: extra.resultBranch } : {}),
      ...(extra?.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId)));
}

export async function setSessionState(
  db: Db,
  workspaceId: string,
  sessionId: string,
  state: SessionState,
  extra?: { diffRef?: string; endedAt?: string },
): Promise<void> {
  await db
    .update(session)
    .set({
      state,
      ...(extra?.diffRef !== undefined ? { diffRef: extra.diffRef } : {}),
      ...(extra?.endedAt !== undefined ? { endedAt: extra.endedAt } : {}),
    })
    .where(and(eq(session.workspaceId, workspaceId), eq(session.id, sessionId)));
}

/**
 * Append-only agent event log (TASK-018 replay). Every streamed event is persisted before a
 * client can ask for it again, so a reconnecting SPA replays exactly what it missed instead of
 * losing terminal history. `seq` is unique per Session, so a retried durable step that re-emits
 * the same event is a no-op rather than a duplicate.
 */
export async function appendSessionEvent(
  db: Db,
  workspaceId: string,
  input: { sessionId: string; seq: number; kind: string; payload: unknown },
): Promise<void> {
  await db
    .insert(sessionEvent)
    .values({
      workspaceId,
      sessionId: input.sessionId,
      seq: input.seq,
      kind: input.kind,
      payload: input.payload,
    })
    .onConflictDoNothing();
}

/**
 * Record one turn's token usage (issue #14).
 *
 * Keyed on `(sessionId, seq)` like the event log and inserted with `onConflictDoNothing`, so a
 * durable step that replays after an orchestrator restart re-records the same turn as a no-op
 * rather than double-counting it (Principle III).
 *
 * Counts and model only. Nothing derived from the prompt or the completion is stored here.
 */
export async function recordSessionUsage(
  db: Db,
  workspaceId: string,
  input: {
    sessionId: string;
    taskId: string;
    agentProfileId: string;
    /** The assistant turn. Repeats for the same turn are ignored — see the schema comment. */
    messageId: string;
    seq: number;
    model: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reported: boolean;
  },
): Promise<void> {
  await db
    .insert(sessionUsage)
    .values({
      workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      agentProfileId: input.agentProfileId,
      messageId: input.messageId,
      seq: input.seq,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      reported: input.reported,
    })
    .onConflictDoNothing();
}

/**
 * The next usage `seq` for a Session — an ordering hint, read from the database because a
 * Session spans review rounds and each round re-enters the durable step with a fresh closure.
 *
 * Identity lives on `messageId`, not here: a repeated or replayed turn is rejected by the
 * unique index regardless of what sequence number it arrives with.
 */
export async function nextSessionUsageSeq(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({ seq: sessionUsage.seq })
    .from(sessionUsage)
    .where(and(eq(sessionUsage.workspaceId, workspaceId), eq(sessionUsage.sessionId, sessionId)))
    .orderBy(desc(sessionUsage.seq))
    .limit(1);
  return row ? row.seq + 1 : 0;
}

/** Every usage row for a Session, oldest turn first. */
export async function listSessionUsage(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<(typeof sessionUsage.$inferSelect)[]> {
  return db
    .select()
    .from(sessionUsage)
    .where(and(eq(sessionUsage.workspaceId, workspaceId), eq(sessionUsage.sessionId, sessionId)))
    .orderBy(sessionUsage.seq);
}

/** The next free `seq` for a Session (resumes correctly after an orchestrator restart). */
export async function nextSessionEventSeq(
  db: Db,
  workspaceId: string,
  sessionId: string,
): Promise<number> {
  const [row] = await db
    .select({ seq: sessionEvent.seq })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.workspaceId, workspaceId), eq(sessionEvent.sessionId, sessionId)))
    .orderBy(desc(sessionEvent.seq))
    .limit(1);
  return row ? row.seq + 1 : 0;
}

export interface ReplayEvent {
  sessionId: string;
  seq: number;
  kind: string;
  payload: unknown;
}

/**
 * Events for a Task's Sessions with `seq` above `sinceSeq`, oldest first. Workspace-scoped:
 * the caller's ticket names the Workspace, and a Task from another one yields nothing.
 */
export async function listTaskEventsSince(
  db: Db,
  workspaceId: string,
  taskId: string,
  sinceSeq: number,
): Promise<ReplayEvent[]> {
  const sessions = await db
    .select({ id: session.id })
    .from(session)
    .where(and(eq(session.workspaceId, workspaceId), eq(session.taskId, taskId)));
  if (sessions.length === 0) return [];

  return db
    .select({
      sessionId: sessionEvent.sessionId,
      seq: sessionEvent.seq,
      kind: sessionEvent.kind,
      payload: sessionEvent.payload,
    })
    .from(sessionEvent)
    .where(
      and(
        eq(sessionEvent.workspaceId, workspaceId),
        inArray(
          sessionEvent.sessionId,
          sessions.map((s) => s.id),
        ),
        gt(sessionEvent.seq, sinceSeq),
      ),
    )
    .orderBy(asc(sessionEvent.seq));
}
