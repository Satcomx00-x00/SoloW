import "server-only";
import { createDb, SEED_WORKSPACE_A } from "@gatecontrol/db";
import { resolveSession } from "./auth/session.js";
import { devOwnerMode } from "./env.js";
import type { BaseContext } from "./trpc.js";

/** Build the per-request tRPC context (Decision 0011). */
export async function createContext({ req }: { req: Request }): Promise<BaseContext> {
  const db = createDb();

  // Local dev-owner path (see `devOwnerMode`): a fixed Owner on the seeded Workspace with the
  // core flag enabled, so the SPA can read live data before BetterAuth is wired.
  if (devOwnerMode()) {
    return {
      db,
      session: { workspaceId: SEED_WORKSPACE_A, userId: "local-owner" },
      flagOverrides: { "ff-core-program": true },
    };
  }

  return { db, session: await resolveSession(req.headers) };
}
