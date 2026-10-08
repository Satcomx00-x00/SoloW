import "server-only";
import { authSchema, createDb, type Db, provisionOwnerWorkspace, workspace } from "@solow/db";
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
 * **One Owner per instance.** A self-hosted SoloW is one person's control plane, and its
 * Workspace holds their harness credentials. Leaving sign-up open would let anyone who can reach
 * the port create an account on someone else's machine, so the *second* sign-up is refused at
 * the database hook — the closest point to the write, where no route can route around it — and,
 * for two sign-ups that both pass the hook's count, by `auth_user_single_owner` in the INSERT.
 *
 * **The Workspace is settled with the Owner.** `workspaceId` must exist before the first request
 * resolves, and creating it lazily inside session resolution would make a read path write. So it
 * is settled in the same user-creation hook — the local Workspace taken over, or a new one made —
 * and a user without one cannot get a session at all.
 */

/** Model names are remapped: BetterAuth's `session` would collide with our *harness* session. */
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
    appName: "SoloW",
    secret: env.SOLOW_AUTH_SECRET,
    baseURL: env.SOLOW_WEB_URL,
    trustedOrigins: [env.SOLOW_WEB_URL],
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
              throw new Error("SoloW is single-Owner: an account already exists.");
            }
          },
          // The local Workspace bootstrap made, when it is still unclaimed — that is where an
          // install's existing work lives — or a new one seeded the same way bootstrap seeds it.
          after: async (user) => {
            await provisionOwnerWorkspace(db, user);
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
