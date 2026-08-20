import "server-only";
import { CommonErrorCode, type Result } from "@gatecontrol/contracts";
import type { Db } from "@gatecontrol/db";
import { type FlagKey, isEnabled } from "@gatecontrol/db";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { OpenApiMeta } from "trpc-to-openapi";
import type { RequestContext } from "./dal/context.js";
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
  flagOverrides?: Partial<Record<FlagKey, boolean>>;
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

/** Blocks the whole feature when its flag is OFF (kill switch) — one middleware per flag key. */
function requireFlag(flag: FlagKey) {
  return t.middleware(({ ctx, next }) => {
    const workspaceId = ctx.session?.workspaceId;
    if (!workspaceId) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: CommonErrorCode.Unauthorized });
    }
    const flagCtx = ctx.flagOverrides
      ? { workspaceId, overrides: ctx.flagOverrides }
      : { workspaceId };
    if (!isEnabled(flag, flagCtx)) {
      throw new TRPCError({ code: "FORBIDDEN", message: CommonErrorCode.FlagDisabled });
    }
    return next();
  });
}

/** The procedure every core-program endpoint uses. */
export const ownerProcedure = publicProcedure
  .use(requireSession)
  .use(requireFlag("ff-core-program"));

/** The procedure every SCM-integration endpoint uses (issue #15) — a separate kill switch. */
export const integrationsProcedure = publicProcedure
  .use(requireSession)
  .use(requireFlag("ff-integrations"));

/**
 * Token administration for the external MCP server (issue #16) — its own kill switch, so turning
 * off `ff-mcp` stops new tokens being minted as well as stopping the endpoint serving.
 */
export const mcpProcedure = publicProcedure.use(requireSession).use(requireFlag("ff-mcp"));

/**
 * Workflow design and execution (issue #5). Two flags, deliberately: a Workflow procedure moves
 * a Task's cursor, so it must not stay reachable once the core kill switch is off — turning
 * `ff-core-program` off has to stop the whole loop, not just the half of it that predates
 * Workflows.
 */
export const workflowProcedure = publicProcedure
  .use(requireSession)
  .use(requireFlag("ff-core-program"))
  .use(requireFlag("ff-workflows"));

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
