import "server-only";
import { randomUUID } from "node:crypto";
import {
  authSchema,
  createDb,
  type Db,
  ensureDefaultAgentCatalog,
  workspace,
} from "@gatecontrol/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { count, eq } from "drizzle-orm";
import { webEnv } from "../env.js";

/**
 * BetterAuth instance (task TASK-011, plan §"Auth": local single-user Owner with Workspace
 * scoping). This is the single authority on who is signed in; `session.ts` turns that into the
 * `{ workspaceId, userId }` every tRPC procedure is built on.
 *
 * Two decisions worth stating outright:
 *
 * **One Owner per instance.** A self-hosted GateControl is one person's control plane, and its
 * Workspace holds their agent credentials. Leaving sign-up open would let anyone who can reach
 * the port create an account on someone else's machine, so the *second* sign-up is refused at
 * the database hook — the closest point to the write, where no route can route around it.
 *
 * **The Workspace is created with the Owner.** `workspaceId` must exist before the first request
 * resolves, and creating it lazily inside session resolution would make a read path write. So it
 * is created in the same user-creation hook, and a user without one cannot get a session at all.
 */

/** Model names are remapped: BetterAuth's `session` would collide with our *agent* session. */
const MODEL_NAMES = {
  user: { modelName: "authUser" },
  session: { modelName: "authSession" },
  account: { modelName: "authAccount" },
  verification: { modelName: "authVerification" },
} as const;

/** Password floor. Local-first means the attacker is often on the same LAN, not a botnet. */
const MIN_PASSWORD_LENGTH = 12;

export function createAuth(db: Db = createDb()) {
  const env = webEnv();
  return betterAuth({
    appName: "GateControl",
    secret: env.GATECONTROL_AUTH_SECRET,
    baseURL: env.GATECONTROL_WEB_URL,
    trustedOrigins: [env.GATECONTROL_WEB_URL],
    database: drizzleAdapter(db, { provider: "sqlite", schema: authSchema }),
    ...MODEL_NAMES,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // No mail transport is configured in a local-first install, so requiring verification
      // would lock the Owner out of their own machine.
      requireEmailVerification: false,
    },
    // Brute force is the realistic attack on a single-Owner password login.
    rateLimit: { enabled: true, window: 60, max: 20 },
    advanced: {
      useSecureCookies: env.NODE_ENV === "production",
      defaultCookieAttributes: { sameSite: "lax", httpOnly: true },
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (await ownerExists(db)) {
              throw new Error("GateControl is single-Owner: an account already exists.");
            }
          },
          after: async (user) => {
            const workspaceId = randomUUID();
            await db.insert(workspace).values({
              id: workspaceId,
              name: `${user.name || user.email}'s workspace`,
              ownerUserId: user.id,
              // Flags stay at their registry default (OFF) for a new Workspace — the core loop
              // is enabled deliberately, not by signing up (constitution: feature flags).
              enabledFlags: null,
            });
            // Agent identity is a catalog row, not an enum (issue #10) — without this, a
            // brand-new Workspace could not create even the one agent GateControl ships.
            await ensureDefaultAgentCatalog(db, workspaceId);
          },
        },
      },
    },
  });
}

/** Whether this instance already has its Owner — the answer the sign-in page needs. */
export async function ownerExists(db: Db = createDb()): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(authSchema.authUser);
  return (row?.n ?? 0) > 0;
}

/** The Workspace owned by a user, or null when they have none (should not happen post-hook). */
export async function workspaceForUser(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(eq(workspace.ownerUserId, userId))
    .limit(1);
  return row?.id ?? null;
}

/** Lazily built so importing this module does not require the env to be present. */
let cached: ReturnType<typeof createAuth> | undefined;
export function auth(): ReturnType<typeof createAuth> {
  cached ??= createAuth();
  return cached;
}
