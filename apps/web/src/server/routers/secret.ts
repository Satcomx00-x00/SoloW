import "server-only";
import {
  deleteSecretInput,
  secretRefDto,
  setSecretInput,
  setSecretResultDto,
} from "@gatecontrol/contracts";
import { z } from "zod";
import { deleteSecret, listSecretRefs, setSecret } from "../dal/secret.js";
import { taskIdsBlockedByCredential } from "../dal/task.js";
import { ownerProcedure, rateLimit, router, unwrap } from "../trpc.js";
import { resumeTask } from "./task.js";

export const secretRouter = router({
  /**
   * Write-only: returns metadata only, never the value (Principle IV). Rate-limited.
   *
   * Replacing a credential is also how an Owner recovers from a credential-expiry pause (spec
   * AC-013, issue #63) — there is no separate "renew" endpoint, because renewing *is* setting
   * the same Secret again. Every Task that was paused on this Secret is resumed automatically
   * afterwards, so the one click that fixes the credential is the only click the Owner needs.
   *
   * The lookup is unconditional rather than gated on "was this a create or a replace": a Task
   * can only be paused on a Secret that already existed when it failed, so on a brand-new Secret
   * the query below is simply empty — cheaper to run it always than to track which case this is.
   */
  set: ownerProcedure
    .meta({ openapi: { method: "POST", path: "/secret.set", tags: ["secret"], protect: true } })
    .use(rateLimit("secret.set"))
    .input(setSecretInput)
    .output(setSecretResultDto)
    .mutation(async ({ ctx, input }) => {
      const secret = unwrap(await setSecret(ctx.rctx, input));

      const blockedTaskIds = await taskIdsBlockedByCredential(ctx.rctx, secret.id);
      let resumedTaskCount = 0;
      for (const taskId of blockedTaskIds) {
        try {
          await resumeTask(ctx.rctx, taskId);
          resumedTaskCount += 1;
        } catch {
          // A Task that cannot start right now (a dependency added since it failed, the
          // concurrency cap) is left exactly as it was — Parked/Failed and renewable again —
          // rather than letting one Task's refusal stop the rest of the batch from resuming.
        }
      }

      return { secret, resumedTaskCount };
    }),

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
