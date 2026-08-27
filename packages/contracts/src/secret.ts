import { z } from "zod";
import { idSchema } from "./common.js";

/**
 * `scm_pat` holds a GitHub/GitLab Personal Access Token (issue #15) — same write-only shape as
 * every other credential; the value never comes back out of a read. `ssh_key` and
 * `cloud_credential` exist so an Executor Profile can *reference* the credential its runtime
 * needs instead of carrying it inline (issue #73, AC-3). A reference to a secret the product
 * cannot store is not a satisfied criterion.
 */
export const secretKindSchema = z.enum([
  "subscription_token",
  "api_key",
  "scm_pat",
  "ssh_key",
  "cloud_credential",
]);
export type SecretKind = z.infer<typeof secretKindSchema>;

/**
 * Set (create/replace) a Secret. Write-only: the value is never returned by any
 * read (constitution Principle IV; spec F17).
 */
export const setSecretInput = z.object({
  name: z.string().min(1).max(120),
  kind: secretKindSchema,
  value: z.string().min(1).max(8000),
});
export type SetSecretInput = z.infer<typeof setSecretInput>;

/**
 * What still holds a Secret. Carried on every read so the UI can say *which* Integration or
 * Agent Profile depends on a credential before the user tries to delete it, rather than only
 * after the server refuses.
 */
export const secretUsageDto = z.object({
  holder: z.enum(["integration", "agent_profile"]),
  /** How the holder is identified to the user — an Integration's provider, a Profile's name. */
  name: z.string(),
});
export type SecretUsageDto = z.infer<typeof secretUsageDto>;

/** Metadata only — never the value. */
export const secretRefDto = z.object({
  id: idSchema,
  name: z.string(),
  kind: secretKindSchema,
  usedBy: z.array(secretUsageDto),
});
export type SecretRefDto = z.infer<typeof secretRefDto>;

/**
 * The result of `secret.set` — the Secret's metadata, plus how many Tasks the write just
 * unblocked (spec AC-013, issue #63).
 *
 * A wider DTO than `secretRefDto` rather than an extra field bolted onto it, because
 * `resumedTaskCount` means something only for a write: `secret.list` and `secret.delete` return
 * `secretRefDto` on its own, and a count that is always zero on those responses would be a field
 * nobody could tell "genuinely zero" from "not applicable here".
 */
export const setSecretResultDto = z.object({
  secret: secretRefDto,
  /**
   * Every Task that was paused with a failed run against *this* Secret, and has now been
   * restarted. Zero on the far more common case — creating a new Secret, or replacing one that
   * nothing was waiting on.
   */
  resumedTaskCount: z.number().int().nonnegative(),
});
export type SetSecretResultDto = z.infer<typeof setSecretResultDto>;

/**
 * Delete a Secret. Refused with `SECRET_IN_USE` while anything still references it — a stored
 * credential is the only copy SoloW has, and dropping one an Integration or Agent Profile
 * points at breaks that holder with no way to put the value back (spec F17 FR-6).
 */
export const deleteSecretInput = z.object({ id: idSchema });
export type DeleteSecretInput = z.infer<typeof deleteSecretInput>;
