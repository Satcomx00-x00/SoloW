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
 * Everything the product needs to know about a protocol, in one place (refactored 2026-08-28).
 *
 * It used to be four: the pins here, the driven-protocol list and the worktree question in the
 * orchestrator, and the explanatory hints in the Agent Profile form. Three of those four were
 * plain arrays and `===` comparisons, so adding a protocol compiled cleanly and then failed at
 * run time — a Task refused for a protocol that had a driver, or a form offering a setting the
 * runner ignores. A `Record<AgentProtocol, …>` cannot be added to without the compiler naming
 * every field the new member is missing, which is the property that was wanted all along.
 *
 * What is *not* here is how to build a runner: that needs the runner classes, so the switch
 * stays in the orchestrator. `driven` is this file's claim about whether one exists, and a test
 * asserts the switch agrees — the two halves of one question, kept honest by a drift guard
 * rather than by hoping.
 */
export interface AgentProtocolDescriptor {
  /** How it reads where an Owner is choosing one. */
  label: string;
  /** The consequence of choosing it, in the Owner's terms — not a restatement of the enum. */
  hint: string;
  /**
   * Which of a Profile's two pins this protocol can actually be told (issue #94).
   *
   * The two agents SoloW seeds differ here in opposite directions: Claude Code's stream-JSON CLI
   * takes `--model` and has no notion of a session mode, while ACP has `session/set_mode` and no
   * way to select a model. A pin is meaningful for one and inert for the other, and which is
   * which is a property of the protocol, not of the agent.
   */
  pins: { model: boolean; mode: boolean };
  /**
   * Whether the agent makes the Task's worktree itself, or SoloW has to.
   *
   * Claude Code does, via `--worktree`, and SoloW adopts whatever path it reports. The others
   * work in the `cwd` they are given, so the lifecycle provisions it first. The isolation
   * guarantee (Principle II) is the same either way — only who creates the directory changes.
   */
  createsOwnWorktree: boolean;
  /** Whether it can ask the operator mid-run, which only a real request channel allows. */
  canRequestPermission: boolean;
  /** Whether this build has a runner for it. The orchestrator's switch must agree. */
  driven: boolean;
}

export const AGENT_PROTOCOLS: Record<AgentProtocol, AgentProtocolDescriptor> = {
  claude_code_stream_json: {
    label: "Claude Code (stream-JSON)",
    hint: "Claude Code's own headless CLI. No permission channel — the CLI decides for itself.",
    pins: { model: true, mode: false },
    createsOwnWorktree: true,
    canRequestPermission: false,
    driven: true,
  },
  acp: {
    label: "Agent Client Protocol",
    hint: "Agent Client Protocol. Can ask for permission mid-run — this is what the inline elicitation card needs.",
    pins: { model: false, mode: true },
    createsOwnWorktree: false,
    canRequestPermission: true,
    driven: true,
  },
  cli_passthrough: {
    label: "Plain CLI",
    hint: "A plain CLI given the brief as an argument. Its output is the transcript; it has no tools, no permission channel, and nothing to pin.",
    pins: { model: false, mode: false },
    createsOwnWorktree: false,
    canRequestPermission: false,
    driven: true,
  },
};

/**
 * What a protocol this build has never heard of is treated as.
 *
 * Reachable, and not hypothetically: `agent_catalog.protocol` is a plain text column with no
 * CHECK constraint, so a Workspace written by a build that shipped a fourth protocol still opens
 * in one that did not — the same orphan degradation F21 describes for provider ids. The type
 * says `AgentProtocol`; the database does not.
 *
 * Undriven and pinnable-by-nothing, so every derived question answers the safe way: the Task is
 * refused before an agent starts, with the protocol named, and nothing claims a capability for
 * something it cannot even identify. Learned the hard way — the first cut of this record was
 * indexed directly, which turned that clean refusal into a `TypeError` deep inside the
 * lifecycle.
 */
const UNKNOWN_PROTOCOL: AgentProtocolDescriptor = {
  label: "Unknown protocol",
  hint: "This build does not know this protocol. A Task using it is refused before an agent starts.",
  pins: { model: false, mode: false },
  createsOwnWorktree: false,
  canRequestPermission: false,
  driven: false,
};

/**
 * The descriptor for a stored protocol value, whatever it turns out to be.
 *
 * Every consumer goes through this rather than indexing `AGENT_PROTOCOLS` — the record is
 * exhaustive over the enum, and the enum is not exhaustive over the column.
 */
export function agentProtocolDescriptor(protocol: string): AgentProtocolDescriptor {
  return AGENT_PROTOCOLS[protocol as AgentProtocol] ?? UNKNOWN_PROTOCOL;
}

/**
 * Kept as its own export because it is what both the runner and the Profile form ask for, and
 * `AGENT_PROTOCOLS[p].pins` at every call site reads worse than the question being asked.
 */
export const AGENT_PROTOCOL_PINS: Record<AgentProtocol, { model: boolean; mode: boolean }> =
  Object.fromEntries(
    Object.entries(AGENT_PROTOCOLS).map(([protocol, d]) => [protocol, d.pins]),
  ) as Record<AgentProtocol, { model: boolean; mode: boolean }>;

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
