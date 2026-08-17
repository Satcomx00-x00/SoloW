import "server-only";
import { createDb } from "@gatecontrol/db";
import { resolveSession } from "./auth/session.js";
import type { BaseContext } from "./trpc.js";

/** Build the per-request tRPC context (Decision 0011). */
export async function createContext({ req }: { req: Request }): Promise<BaseContext> {
  const session = await resolveSession(req.headers);
  return { db: createDb(), session };
}
