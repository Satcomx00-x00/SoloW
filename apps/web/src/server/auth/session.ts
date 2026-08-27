import "server-only";
import { createDb, type Db } from "@solow/db";
import { createAuth, workspaceForUser } from "./auth.js";

/**
 * Session resolution (task TASK-011). Returns the authenticated Owner's identity and their
 * Workspace, or null when unauthenticated. `workspaceId` originates here — it is looked up from
 * the signed session's user and is never read from client input (Principle V).
 *
 * A user with no Workspace resolves to null rather than to a session without a tenant key: a
 * half-resolved session would leave `workspaceId` to be invented somewhere downstream, which is
 * exactly the failure Principle V exists to prevent.
 */
export interface ResolvedSession {
  workspaceId: string;
  userId: string;
}

export interface SessionDeps {
  db: Db;
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>;
}

function defaultDeps(): SessionDeps {
  const db = createDb();
  const instance = createAuth(db);
  return { db, getSession: (headers) => instance.api.getSession({ headers }) };
}

export async function resolveSession(
  headers: Headers,
  deps: SessionDeps = defaultDeps(),
): Promise<ResolvedSession | null> {
  const session = await deps.getSession(headers);
  if (!session) return null;

  const workspaceId = await workspaceForUser(deps.db, session.user.id);
  if (!workspaceId) return null;

  return { workspaceId, userId: session.user.id };
}
