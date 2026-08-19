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

/** Metadata only — never the value. */
export const secretRefDto = z.object({
  id: idSchema,
  name: z.string(),
  kind: secretKindSchema,
});
export type SecretRefDto = z.infer<typeof secretRefDto>;
