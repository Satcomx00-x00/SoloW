import "server-only";
import { flagDto, setFlagInput } from "@solow/contracts";
import { z } from "zod";
import { listFlags, setFlag } from "../dal/flag.js";
import { router, sessionProcedure, unwrap } from "../trpc.js";

/**
 * List and toggle feature flags for the caller's own Workspace (issue #21).
 *
 * Deliberately NOT built on `ownerProcedure` (or any of the other `requireFlag`-gated
 * procedures in trpc.ts): every one of those requires `ff-core-program` to be ON, and
 * `ff-core-program` itself ships OFF on a fresh Workspace. Gating flag.set the same way would
 * make it impossible to ever turn the core loop on from this Settings UI — the only way in
 * would stay `scripts/flag.ts` on the machine running the instance, which is exactly the
 * chicken-and-egg problem this router exists to close. `sessionProcedure` requires an
 * authenticated session (Principle V's tenancy still applies — every DAL call is scoped to
 * `ctx.rctx.workspaceId`) but chains no flag guard.
 */

export const flagRouter = router({
  /** Every known flag, with the value currently in effect for the caller's own Workspace. */
  list: sessionProcedure
    .meta({ openapi: { method: "GET", path: "/flag.list", tags: ["flag"], protect: true } })
    .input(z.object({}))
    .output(z.array(flagDto))
    .query(async ({ ctx }) => unwrap(await listFlags(ctx.rctx))),

  /** Turn one flag on or off for the caller's own Workspace. Unknown keys are rejected. */
  set: sessionProcedure
    .meta({ openapi: { method: "POST", path: "/flag.set", tags: ["flag"], protect: true } })
    .input(setFlagInput)
    .output(flagDto)
    .mutation(async ({ ctx, input }) => unwrap(await setFlag(ctx.rctx, input))),
});
