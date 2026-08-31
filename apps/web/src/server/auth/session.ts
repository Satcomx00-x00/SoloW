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
  /**
   * Who the Owner is, for a surface that has to name them.
   *
   * Carried here rather than looked up again because verifying a session is not cheap — a cookie
   * to decode, a session row, a user row — and the signed-in layout was paying for it twice on
   * every page render: once through this function for the tenant key, and once more directly
   * against the auth instance purely to put a name and an email in the header. Two round trips
   * to the same tables, in series, before anything rendered.
   *
   * Null when the session is resolved without an account behind it, which is the dev-owner
   * stand-in: `userId` is then a fixed string and there is nobody to name. A caller must say so
   * rather than invent a name, which is why this is nullable and not an empty string.
   */
  identity: { name: string; email: string } | null;
}

export interface SessionDeps {
  db: Db;
  /**
   * The user's own fields are optional because a caller may stub this with only what session
   * resolution structurally needs — an id. A stub that omits them resolves to a null `identity`,
   * the same shape the dev-owner path produces.
   */
  getSession: (
    headers: Headers,
  ) => Promise<{ user: { id: string; name?: string | null; email?: string | null } } | null>;
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

  const { id, name, email } = session.user;
  return {
    workspaceId,
    userId: id,
    // Both or neither: a header showing a name with no address, or an address with no name, is a
    // half-rendered identity, and the shell already knows how to say "no account behind this".
    identity: name && email ? { name, email } : null,
  };
}
