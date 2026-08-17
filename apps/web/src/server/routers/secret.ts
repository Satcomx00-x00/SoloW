import "server-only";
import { setSecretInput } from "@gatecontrol/contracts";
import { ownerProcedure, router, unwrap } from "../trpc.js";
import { setSecret } from "../dal/secret.js";

export const secretRouter = router({
  /** Write-only: returns metadata only, never the value (Principle IV). */
  set: ownerProcedure
    .input(setSecretInput)
    .mutation(async ({ ctx, input }) => unwrap(await setSecret(ctx.rctx, input))),
});
