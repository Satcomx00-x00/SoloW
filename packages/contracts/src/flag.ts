import { z } from "zod";

/**
 * Feature flags surfaced from Settings (issue #21). The registry itself — the set of known
 * keys, their descriptions and defaults — lives in `@solow/db`'s `flag-registry.ts`; `key` is
 * typed as a plain validated string here rather than a duplicated enum, so registering a new
 * flag there is the only step needed to add one, not also an edit to this schema.
 */
export const flagDto = z.object({
  key: z.string().min(1),
  description: z.string(),
  default: z.boolean(),
  /** The value currently in effect for the caller's Workspace: a stored override, or `default`. */
  enabled: z.boolean(),
});
export type FlagDto = z.infer<typeof flagDto>;

export const setFlagInput = z.object({
  key: z.string().min(1),
  enabled: z.boolean(),
});
export type SetFlagInput = z.infer<typeof setFlagInput>;
