import { z } from "zod";
import {
  agentKindSchema,
  authModeSchema,
  executorKindSchema,
  idSchema,
  timestampsSchema,
} from "./common.js";

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

/** Executor Profile — v1 supports the local kind only (spec F07). */
export const createExecutorProfileInput = z.object({
  name: z.string().min(1).max(120),
  kind: executorKindSchema.default("local"),
});
export type CreateExecutorProfileInput = z.infer<
  typeof createExecutorProfileInput
>;

export const executorProfileDto = z
  .object({
    id: idSchema,
    name: z.string(),
    kind: executorKindSchema,
  })
  .merge(timestampsSchema);
export type ExecutorProfileDto = z.infer<typeof executorProfileDto>;
