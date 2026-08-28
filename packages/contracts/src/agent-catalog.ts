import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

/**
 * Agent catalog (issue #10, spec F05). Agent identity is a row, not a code path: comparable
 * tools support upwards of 20 agent CLIs, SoloW one — and the gap is one schema decision
 * standing in front of that work, not twenty integrations' worth. Adding a supported agent becomes a seed
 * row plus an Agent Profile pointing at it, never a change to application code (AC-1).
 *
 * Workspace-scoped, matching every other tenant-owned table (Principle V): a self-hoster who
 * wires up a custom agent CLI does it for their own Workspace, not the whole install.
 */

export const agentProtocolSchema = z.enum([
  /**
   * Claude Code's own headless stream-JSON CLI protocol (`packages/claude-code`) — a vendor
   * protocol, not ACP, and the only one SoloW can actually drive today. Kept distinct
   * from `acp` rather than pretended into it; see issue #58.
   */
  "claude_code_stream_json",
  /** Issue #58 — real ACP JSON-RPC over stdio. */
  "acp",
  /** Issue #21 — a plain CLI driven by arguments and stdout, for an agent that speaks neither. */
  "cli_passthrough",
]);
export type AgentProtocol = z.infer<typeof agentProtocolSchema>;

/**
 * Which of a Profile's two pins a protocol can actually be told (issue #94; generalised
 * 2026-08-28 when opencode made the difference visible).
 *
 * A Profile can pin a model and a mode, and the two agents SoloW seeds differ on exactly this
 * axis and in opposite directions: Claude Code's stream-JSON CLI takes `--model` and has no
 * notion of a session mode, while ACP has `session/set_mode` and no way to select a model. So a
 * pin is meaningful for one and inert for the other, and which is which is a property of the
 * protocol, not of the agent.
 *
 * It lives here, in the contracts both sides already import, because the alternative is stating
 * it twice — once where a run reports what it could not honour
 * (`unsupportedLaunchSettings`), once where the Owner is choosing (the Agent Profile form) — and
 * two copies of a rule like this drift into a form that accepts a setting the runner then
 * ignores. That is the silent substitution this rule exists to prevent, so it must not be the
 * shape of its own implementation.
 */
export const AGENT_PROTOCOL_PINS: Record<AgentProtocol, { model: boolean; mode: boolean }> = {
  claude_code_stream_json: { model: true, mode: false },
  acp: { model: false, mode: true },
  // Arguments and stdout: it is told neither, and there is no runner for it yet regardless.
  cli_passthrough: { model: false, mode: false },
};

/**
 * A cache of what the agent last advertised, not the truth. Once #58 lands, models and modes
 * come from the ACP handshake; this is the fallback shown before an agent has ever run.
 */
export const agentCapabilitiesSchema = z
  .object({
    models: z.array(z.string().min(1)).default([]),
    modes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;
export const DEFAULT_AGENT_CAPABILITIES: AgentCapabilities = { models: [], modes: [] };

const envVarName = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "environment variable names must match [A-Za-z_][A-Za-z0-9_]*",
  );

const catalogKey = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, "lowercase snake_case, e.g. claude_code");

/**
 * `subscriptionEnvVar` / `meteredEnvVar` are the reason this table exists rather than a JSON
 * blob: the billing strip in `billing.ts` used to hardcode `CLAUDE_CODE_OAUTH_TOKEN` /
 * `ANTHROPIC_API_KEY`. That guarantee — subscription billing can never leak into metered API
 * billing (Principle IV) — is SoloW's headline differentiator, and it silently stops
 * holding the moment a second agent lands unless which variables to strip is *data* the guard
 * reads, not a constant it assumes.
 */
export const createAgentCatalogEntryInput = z.object({
  key: catalogKey,
  displayName: z.string().min(1).max(120),
  protocol: agentProtocolSchema,
  command: z.string().min(1),
  argsTemplate: z.array(z.string()).max(64).default([]),
  installHint: z.string().max(500).nullable().default(null),
  subscriptionEnvVar: envVarName,
  meteredEnvVar: envVarName,
  capabilities: agentCapabilitiesSchema.default(DEFAULT_AGENT_CAPABILITIES),
});
export type CreateAgentCatalogEntryInput = z.infer<typeof createAgentCatalogEntryInput>;

export const agentCatalogEntryDto = z
  .object({
    id: idSchema,
    key: catalogKey,
    displayName: z.string(),
    protocol: agentProtocolSchema,
    command: z.string(),
    argsTemplate: z.array(z.string()),
    installHint: z.string().nullable(),
    subscriptionEnvVar: z.string(),
    meteredEnvVar: z.string(),
    capabilities: agentCapabilitiesSchema,
  })
  .merge(timestampsSchema);
export type AgentCatalogEntryDto = z.infer<typeof agentCatalogEntryDto>;

/** The row every Workspace is seeded with (`packages/db/src/seed.ts`, migration 0004). */
export const CLAUDE_CODE_CATALOG_KEY = "claude_code";
