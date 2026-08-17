import { and, eq } from "drizzle-orm";
import type { SessionState, TaskState } from "@gatecontrol/contracts";
import {
  type Db,
  agentProfile,
  repository,
  secret,
  session,
  task,
} from "@gatecontrol/db";

/**
 * Orchestrator-side data access. Scoped by workspaceId (the tenant key travels on the
 * launch event, originating from the authenticated session that created it — Principle V).
 * Kept separate from the web DAL, which is `server-only` and request-context bound.
 */

export interface TaskRunContext {
  task: typeof task.$inferSelect;
  agentProfile: typeof agentProfile.$inferSelect;
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

  const [ap] = await db
    .select()
    .from(agentProfile)
    .where(and(eq(agentProfile.workspaceId, workspaceId), eq(agentProfile.id, t.agentProfileId)))
    .limit(1);
  if (!ap) throw new Error(`agent profile ${t.agentProfileId} not found`);

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

  return { task: t, agentProfile: ap, repository: repo, secretCiphertext: sec?.ciphertext ?? null };
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
