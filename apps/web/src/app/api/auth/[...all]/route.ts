import { auth } from "@/server/auth/auth";

/**
 * BetterAuth's catch-all endpoint (task TASK-011): sign-up, sign-in, sign-out, session.
 *
 * Runs on the Node/Bun runtime like the tRPC handler — the auth adapter reaches the same
 * `bun:sqlite` database. It is *not* wrapped in the app's own auth guard, for the obvious
 * reason that this is where a session comes from.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(req: Request): Promise<Response> {
  return auth().handler(req);
}

export { handler as GET, handler as POST };
