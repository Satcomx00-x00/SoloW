import "server-only";
import { CommonErrorCode, type Result } from "@gatecontrol/contracts";
import type { Db } from "@gatecontrol/db";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { OpenApiMeta } from "trpc-to-openapi";
import type { RequestContext } from "./dal/context.js";
import { isEnabled } from "./flags.js";
import { checkRateLimit, RATE_LIMITS, type RateLimitedProcedure } from "./rate-limit.js";

/**
 * tRPC setup (Decision 0011). Procedures enforce the constitution discipline:
 * Parse (Zod input) → Authorize (session) → Ownership (workspaceId) → DTO, plus a
 * feature-flag guard on every core procedure (Principle V/VI; task TASK-011).
 */

export interface BaseContext {
  db: Db;
  /** Resolved from the authenticated session; null when unauthenticated. */
  session: { workspaceId: string; userId: string } | null;
  flagOverrides?: Partial<Record<"ff-core-program", boolean>>;
}

const t = initTRPC.meta<OpenApiMeta>().context<BaseContext>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

/** Requires an authenticated session; provides a RequestContext downstream. */
const requireSession = t.middleware(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: CommonErrorCode.Unauthorized });
  }
  const rctx: RequestContext = {
    db: ctx.db,
    workspaceId: ctx.session.workspaceId,
    userId: ctx.session.userId,
  };
  return next({ ctx: { ...ctx, rctx } });
});

/** Blocks the whole feature when the flag is OFF (kill switch). */
const requireCoreFlag = t.middleware(({ ctx, next }) => {
  const workspaceId = ctx.session?.workspaceId;
  if (!workspaceId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: CommonErrorCode.Unauthorized });
  }
  const flagCtx = ctx.flagOverrides
    ? { workspaceId, overrides: ctx.flagOverrides }
    : { workspaceId };
  if (!isEnabled("ff-core-program", flagCtx)) {
    throw new TRPCError({ code: "FORBIDDEN", message: CommonErrorCode.FlagDisabled });
  }
  return next();
});

/** The procedure every core-program endpoint uses. */
export const ownerProcedure = publicProcedure.use(requireSession).use(requireCoreFlag);

/**
 * Per-Owner rate limit for a sensitive write. Returns a middleware to chain after
 * `ownerProcedure` (session already required), tripping `TOO_MANY_REQUESTS` past the window
 * limit (plan §12).
 */
export function rateLimit(name: RateLimitedProcedure) {
  return t.middleware(({ ctx, next }) => {
    const workspaceId = ctx.session?.workspaceId;
    if (!workspaceId) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: CommonErrorCode.Unauthorized });
    }
    if (!checkRateLimit(`${name}:${workspaceId}`, RATE_LIMITS[name])) {
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: CommonErrorCode.RateLimited });
    }
    return next();
  });
}

/** Map a DAL/service Result error into a TRPCError, or return the data. */
export function unwrap<T>(result: Result<T, string>): T {
  if (result.ok) return result.data;
  const code = result.error;
  const map: Record<string, TRPCError["code"]> = {
    [CommonErrorCode.Unauthorized]: "UNAUTHORIZED",
    [CommonErrorCode.Forbidden]: "FORBIDDEN",
    [CommonErrorCode.NotFound]: "NOT_FOUND",
    [CommonErrorCode.ValidationFailed]: "BAD_REQUEST",
    [CommonErrorCode.RateLimited]: "TOO_MANY_REQUESTS",
  };
  throw new TRPCError({ code: map[code] ?? "BAD_REQUEST", message: code });
}
