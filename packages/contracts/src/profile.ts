import { z } from "zod";
import { authModeSchema, idSchema, timestampsSchema } from "./common.js";
import {
  DEFAULT_EXECUTOR_CONFIG,
  executorConfigSchema,
  executorKindSchema,
} from "./executor-config.js";

/**
 * How much an agent may do without stopping to ask (spec F05).
 *
 * These are the vendor CLI's own `--permission-mode` values, deliberately not renamed: the
 * profile is configuring the agent, and inventing a second vocabulary for it would mean
 * translating in both directions and being wrong the day the CLI adds a fourth.
 *
 * - `acceptEdits` — the default, and what every Profile ran as before this field existed. The
 *   agent edits inside its own worktree freely and asks for everything else.
 * - `plan` — it may read and reason but not change anything. A Profile for "tell me what you
 *   would do" rather than "do it".
 * - `bypassPermissions` — it never asks.
 *
 * The last one deserves its name. GateControl runs an agent headless, in a worktree, with **no
 * channel to ask an operator on** for the stream-json protocol — so under `acceptEdits` every
 * shell command and every fetch is refused by a prompt nobody can answer, and a task that needs
 * either simply cannot be done (observed: an agent asking for `pip index versions` in a loop
 * until it gave up). `bypassPermissions` is the answer to that, and it is a real grant: the
 * agent gets the shell and the network, bounded by the worktree it runs in and by the review
 * gate that still holds every change before it reaches a branch (Principle I).
 */
export const agentPermissionModeSchema = z.enum(["acceptEdits", "plan", "bypassPermissions"]);
export type AgentPermissionMode = z.infer<typeof agentPermissionModeSchema>;

/**
 * What a Profile runs as when it says nothing.
 *
 * `bypassPermissions`, by decision (2026-08-22): GateControl runs agents headless, and under any
 * asking mode a prompt reaches nobody — so the cautious-looking default did not produce caution,
 * it produced runs that failed partway through with the work half done. The bound on an agent is
 * the worktree it is confined to and the review gate every change still stops at (Principle I),
 * not a question with no answerer.
 *
 * A Profile can still choose otherwise, and `plan` in particular is a real posture for an agent
 * meant to propose rather than act.
 */
export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = "bypassPermissions";

/**
 * Agent Profile (spec F05/F06, issue #10). `agentCatalogId` replaces the old closed
 * `agentKind` enum — which agent this Profile runs, and how, is data in `agent_catalog`, not a
 * literal the contract has to know about.
 */
export const createAgentProfileInput = z.object({
  name: z.string().min(1).max(120),
  agentCatalogId: idSchema,
  authMode: authModeSchema,
  /** References a stored Secret (subscription token or API key). */
  secretId: idSchema,
  concurrencyCap: z.number().int().min(1).max(20).default(3),
  permissionMode: agentPermissionModeSchema.default(DEFAULT_AGENT_PERMISSION_MODE),
});
export type CreateAgentProfileInput = z.infer<typeof createAgentProfileInput>;

/**
 * What still holds this Agent Profile, so Settings can disable Delete and say why before the
 * Owner tries it rather than only after the server refuses (same reasoning as `secretRefDto`'s
 * `usedBy`). Counts rather than named rows: unlike a Secret — typically held by one or two named
 * Integrations or Profiles — a Profile can be referenced by hundreds of Tasks, and "used by 42
 * tasks" is the useful summary, not a list of their titles.
 */
export const agentProfileUsageDto = z.object({
  taskCount: z.number().int().nonnegative(),
  workflowStepCount: z.number().int().nonnegative(),
  /** Historical billing attribution (issue #14) — present even for a Profile whose every Task
   * has since been deleted, which is exactly the case a Task/Step count alone would miss. */
  sessionUsageCount: z.number().int().nonnegative(),
});
export type AgentProfileUsageDto = z.infer<typeof agentProfileUsageDto>;

export const agentProfileDto = z
  .object({
    id: idSchema,
    name: z.string(),
    agentCatalogId: idSchema,
    authMode: authModeSchema,
    secretId: idSchema,
    concurrencyCap: z.number().int(),
    permissionMode: agentPermissionModeSchema,
    usage: agentProfileUsageDto,
  })
  .merge(timestampsSchema);
export type AgentProfileDto = z.infer<typeof agentProfileDto>;

/**
 * Edit a Profile. No `agentCatalogId`, `authMode` or `secretId`: which agent a Profile runs and
 * how it authenticates are what a Profile *is*, and changing them under Tasks that already
 * reference it would rewrite the meaning of finished runs. What can change is what it is called,
 * how many of it may run at once, and how much it is allowed to do.
 */
export const updateAgentProfileInput = z.object({
  id: idSchema,
  name: z.string().min(1).max(120).optional(),
  concurrencyCap: z.number().int().min(1).max(20).optional(),
  permissionMode: agentPermissionModeSchema.optional(),
});
export type UpdateAgentProfileInput = z.infer<typeof updateAgentProfileInput>;

export const deleteAgentProfileInput = z.object({ id: idSchema });
export type DeleteAgentProfileInput = z.infer<typeof deleteAgentProfileInput>;

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
