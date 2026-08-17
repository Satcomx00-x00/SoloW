import "server-only";
import { secretRefDto, setSecretInput } from "@gatecontrol/contracts";
import { z } from "zod";
import { listSecretRefs, setSecret } from "../dal/secret.js";
import { ownerProcedure, rateLimit, router, unwrap } from "../trpc.js";

export const secretRouter = router({
  /** Write-only: returns metadata only, never the value (Principle IV). Rate-limited. */
  set: ownerProcedure
    .meta({ openapi: { method: "POST", path: "/secret.set", tags: ["secret"], protect: true } })
    .use(rateLimit("secret.set"))
    .input(setSecretInput)
    .output(secretRefDto)
    .mutation(async ({ ctx, input }) => unwrap(await setSecret(ctx.rctx, input))),

  /** List Secret metadata (id/name/kind) — never the value. */
  list: ownerProcedure
    .meta({ openapi: { method: "GET", path: "/secret.list", tags: ["secret"], protect: true } })
    .input(z.object({}))
    .output(z.array(secretRefDto))
    .query(async ({ ctx }) => unwrap(await listSecretRefs(ctx.rctx))),
});
