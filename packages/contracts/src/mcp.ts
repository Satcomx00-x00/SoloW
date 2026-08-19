import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

/**
 * External MCP server (issue #16, parity row 74).
 *
 * A token is the *only* new authentication surface this feature introduces, and it is
 * deliberately shaped so it cannot become a second authorisation path (issue #16's stated
 * "one way this feature can become a security incident"): a token names a Workspace and a
 * capability set, and everything downstream still runs through the same tRPC middleware the
 * SPA uses. Nothing here grants access on its own.
 */

/**
 * What a token may do, coarse-grained on purpose.
 *
 * `read` maps to tRPC queries and `write` to mutations — the split the router already makes,
 * rather than a second per-procedure permission model that would drift from it. A finer
 * catalogue (per-procedure grants) is a strictly additive change later; starting fine-grained
 * would mean inventing a permission for each of the 28 procedures with no caller asking for it.
 */
export const mcpScopeSchema = z.enum(["read", "read_write"]);
export type McpScope = z.infer<typeof mcpScopeSchema>;

export const issueMcpTokenInput = z.object({
  label: z.string().min(1).max(120),
  scope: mcpScopeSchema.default("read"),
});
export type IssueMcpTokenInput = z.infer<typeof issueMcpTokenInput>;

export const revokeMcpTokenInput = z.object({ id: idSchema });
export type RevokeMcpTokenInput = z.infer<typeof revokeMcpTokenInput>;

/**
 * Token metadata. Deliberately has no field that could carry the secret: the value exists in a
 * DTO exactly once, in `issuedMcpTokenDto` below, and this is the shape every read returns
 * (Principle IV — same discipline as `secretRefDto`).
 *
 * `prefix` is the first few characters of the token, stored in the clear so the UI can tell two
 * tokens apart in a list without the value being recoverable from it.
 */
export const mcpTokenDto = z
  .object({
    id: idSchema,
    label: z.string(),
    scope: mcpScopeSchema,
    prefix: z.string(),
    lastUsedAt: z.string().datetime().nullable(),
    revokedAt: z.string().datetime().nullable(),
  })
  .merge(timestampsSchema);
export type McpTokenDto = z.infer<typeof mcpTokenDto>;

/**
 * The one place a token value is returned (AC-4: "displaying a token value exactly once").
 * Only `mcpToken.issue` produces this; it is never persisted in recoverable form, so a lost
 * token is reissued rather than looked up.
 */
export const issuedMcpTokenDto = z.object({
  token: mcpTokenDto,
  /** Shown once, at issue time, and not retrievable afterwards. */
  value: z.string(),
});
export type IssuedMcpTokenDto = z.infer<typeof issuedMcpTokenDto>;
