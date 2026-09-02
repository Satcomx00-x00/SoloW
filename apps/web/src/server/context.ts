import "server-only";
import { createDb, LOCAL_WORKSPACE_ID } from "@solow/db";
import { resolveSession } from "./auth/session.js";
import { getWorkspaceFlags } from "./dal/workspace.js";
import { devOwnerMode } from "./env.js";
import type { BaseContext } from "./trpc.js";

/** Build the per-request tRPC context (Decision 0011). */
export async function createContext({ req }: { req: Request }): Promise<BaseContext> {
  const db = createDb();
  // Read once, here, rather than by any procedure reaching for headers of its own: a request
  // fact belongs on the request context. See `BaseContext.requestHost` for the one use.
  const requestHost = req.headers.get("host");

  // Local dev-owner path (see `devOwnerMode`): a fixed Owner on the local Workspace with the
  // core flag enabled, so the SPA and the E2E harness can run without a sign-in.
  if (devOwnerMode()) {
    return {
      db,
      requestHost,
      session: { workspaceId: LOCAL_WORKSPACE_ID, userId: "local-owner" },
      flagOverrides: { "ff-core-program": true, "ff-integrations": true, "ff-mcp": true },
    };
  }

  const session = await resolveSession(req.headers);
  if (!session) return { db, requestHost, session: null };

  // Flags are per-Workspace and default OFF; the override comes from the Workspace row, so
  // enabling the core loop is a deliberate act and clearing it is the kill switch.
  return {
    db,
    requestHost,
    session,
    flagOverrides: await getWorkspaceFlags(db, session.workspaceId),
  };
}
