import { z } from "zod";
import { idSchema } from "./common.js";

export const secretKindSchema = z.enum(["subscription_token", "api_key"]);
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
