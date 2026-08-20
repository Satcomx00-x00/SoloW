import "server-only";
import { deleteSecretInput, secretRefDto, setSecretInput } from "@gatecontrol/contracts";
import { z } from "zod";
import { deleteSecret, listSecretRefs, setSecret } from "../dal/secret.js";
import { ownerProcedure, rateLimit, router, unwrap } from "../trpc.js";

export const secretRouter = router({
  /** Write-only: returns metadata only, never the value (Principle IV). Rate-limited. */
  set: ownerProcedure
    .meta({ openapi: { method: "POST", path: "/secret.set", tags: ["secret"], protect: true } })
    .use(rateLimit("secret.set"))
    .input(setSecretInput)
    .output(secretRefDto)
    .mutation(async ({ ctx, input }) => unwrap(await setSecret(ctx.rctx, input))),

  /** List Secret metadata (id/name/kind/usedBy) — never the value. */
  list: ownerProcedure
    .meta({ openapi: { method: "GET", path: "/secret.list", tags: ["secret"], protect: true } })
    .input(z.object({}))
    .output(z.array(secretRefDto))
    .query(async ({ ctx }) => unwrap(await listSecretRefs(ctx.rctx))),

  /**
   * Delete a Secret. Refused with `SECRET_IN_USE` while an Integration or Agent Profile still
   * references it — the stored value is unrecoverable, so this is not a mistake a user can undo
   * by re-entering it (spec F17 FR-6). Returns the metadata of the row that was removed.
   */
  delete: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/secret.delete",
        tags: ["secret"],
        protect: true,
        summary:
          "Delete a Secret. Refused while an Integration or Agent Profile still references it.",
      },
    })
    .input(deleteSecretInput)
    .output(secretRefDto)
    .mutation(async ({ ctx, input }) => unwrap(await deleteSecret(ctx.rctx, input))),
});
