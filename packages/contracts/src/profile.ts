import { z } from "zod";
import { agentKindSchema, authModeSchema, idSchema, timestampsSchema } from "./common.js";
import {
  DEFAULT_EXECUTOR_CONFIG,
  executorConfigSchema,
  executorKindSchema,
} from "./executor-config.js";

/** Agent Profile (spec F05/F06). Subscription concurrency cap defaults to 3. */
export const createAgentProfileInput = z.object({
  name: z.string().min(1).max(120),
  agentKind: agentKindSchema.default("claude_code"),
  authMode: authModeSchema,
  /** References a stored Secret (subscription token or API key). */
  secretId: idSchema,
  concurrencyCap: z.number().int().min(1).max(20).default(3),
});
export type CreateAgentProfileInput = z.infer<typeof createAgentProfileInput>;

export const agentProfileDto = z
  .object({
    id: idSchema,
    name: z.string(),
    agentKind: agentKindSchema,
    authMode: authModeSchema,
    secretId: idSchema,
    concurrencyCap: z.number().int(),
  })
  .merge(timestampsSchema);
export type AgentProfileDto = z.infer<typeof agentProfileDto>;

/**
 * Executor Profile (spec F07, issue #73).
 *
 * The kind is *inside* the configuration, not beside it: a separate `kind` field could disagree
 * with `config.kind`, and there is no sensible answer to which one a driver should believe. The
 * `executor_profile.kind` column is a denormalised copy the DAL derives on write, kept only so
 * the kind is queryable.
 */
export const createExecutorProfileInput = z.object({
  name: z.string().min(1).max(120),
  config: executorConfigSchema.default(DEFAULT_EXECUTOR_CONFIG),
});
export type CreateExecutorProfileInput = z.infer<typeof createExecutorProfileInput>;

export const updateExecutorProfileInput = z.object({
  id: idSchema,
  name: z.string().min(1).max(120).optional(),
  config: executorConfigSchema.optional(),
});
export type UpdateExecutorProfileInput = z.infer<typeof updateExecutorProfileInput>;

/**
 * The configuration is safe to return: every member holds secret *references*, never secret
 * values (AC-3), so there is nothing here to redact.
 */
export const executorProfileDto = z
  .object({
    id: idSchema,
    name: z.string(),
    kind: executorKindSchema,
    config: executorConfigSchema,
  })
  .merge(timestampsSchema);
export type ExecutorProfileDto = z.infer<typeof executorProfileDto>;
