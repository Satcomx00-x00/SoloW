import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

/**
 * Harness catalog (issue #10, spec F05). Harness identity is a row, not a code path: comparable
 * tools support upwards of 20 harness CLIs, SoloW one — and the gap is one schema decision
 * standing in front of that work, not twenty integrations' worth. Adding a supported harness becomes a seed
 * row plus a Harness Profile pointing at it, never a change to application code (AC-1).
 *
 * Workspace-scoped, matching every other tenant-owned table (Principle V): a self-hoster who
 * wires up a custom harness CLI does it for their own Workspace, not the whole install.
 */

export const harnessProtocolSchema = z.enum([
  /**
   * Claude Code's own headless stream-JSON CLI protocol (`packages/claude-code`) — a vendor
   * protocol, not ACP, and the only one SoloW can actually drive today. Kept distinct
   * from `acp` rather than pretended into it; see issue #58.
   */
  "claude_code_stream_json",
  /** Issue #58 — real ACP JSON-RPC over stdio. */
  "acp",
  /** Issue #21 — a plain CLI driven by arguments and stdout, for a harness that speaks neither. */
  "cli_passthrough",
]);
export type HarnessProtocol = z.infer<typeof harnessProtocolSchema>;

/**
 * Everything the product needs to know about a protocol, in one place (refactored 2026-08-28).
 *
 * It used to be four: the pins here, the driven-protocol list and the worktree question in the
 * orchestrator, and the explanatory hints in the Harness Profile form. Three of those four were
 * plain arrays and `===` comparisons, so adding a protocol compiled cleanly and then failed at
 * run time — a Task refused for a protocol that had a driver, or a form offering a setting the
 * runner ignores. A `Record<HarnessProtocol, …>` cannot be added to without the compiler naming
 * every field the new member is missing, which is the property that was wanted all along.
 *
 * What is *not* here is how to build a runner: that needs the runner classes, so the switch
 * stays in the orchestrator. `driven` is this file's claim about whether one exists, and a test
 * asserts the switch agrees — the two halves of one question, kept honest by a drift guard
 * rather than by hoping.
 */
export interface HarnessProtocolDescriptor {
  /** How it reads where an Owner is choosing one. */
  label: string;
  /** The consequence of choosing it, in the Owner's terms — not a restatement of the enum. */
  hint: string;
  /**
   * Which of a Profile's two pins this protocol can actually be told (issue #94).
   *
   * The two harnesses SoloW seeds differ here in opposite directions: Claude Code's stream-JSON CLI
   * takes `--model` and has no notion of a session mode, while ACP has `session/set_mode` and no
   * way to select a model. A pin is meaningful for one and inert for the other, and which is
   * which is a property of the protocol, not of the harness.
   */
  pins: { model: boolean; mode: boolean };
  /**
   * Whether the harness makes the Task's worktree itself, or SoloW has to.
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

export const HARNESS_PROTOCOLS: Record<HarnessProtocol, HarnessProtocolDescriptor> = {
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
    // Both pins go through the list the harness advertised in `session/new`: `session/set_mode`
    // and `session/set_model`. Verified against opencode 1.18, which offers 362 models and 3
    // modes; a harness that advertises neither is simply never sent either.
    pins: { model: true, mode: true },
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
 * says `HarnessProtocol`; the database does not.
 *
 * Undriven and pinnable-by-nothing, so every derived question answers the safe way: the Task is
 * refused before a harness starts, with the protocol named, and nothing claims a capability for
 * something it cannot even identify. Learned the hard way — the first cut of this record was
 * indexed directly, which turned that clean refusal into a `TypeError` deep inside the
 * lifecycle.
 */
const UNKNOWN_PROTOCOL: HarnessProtocolDescriptor = {
  label: "Unknown protocol",
  hint: "This build does not know this protocol. A Task using it is refused before a harness starts.",
  pins: { model: false, mode: false },
  createsOwnWorktree: false,
  canRequestPermission: false,
  driven: false,
};

/**
 * The descriptor for a stored protocol value, whatever it turns out to be.
 *
 * Every consumer goes through this rather than indexing `HARNESS_PROTOCOLS` — the record is
 * exhaustive over the enum, and the enum is not exhaustive over the column.
 */
export function harnessProtocolDescriptor(protocol: string): HarnessProtocolDescriptor {
  return HARNESS_PROTOCOLS[protocol as HarnessProtocol] ?? UNKNOWN_PROTOCOL;
}

/**
 * Kept as its own export because it is what both the runner and the Profile form ask for, and
 * `HARNESS_PROTOCOLS[p].pins` at every call site reads worse than the question being asked.
 */
export const HARNESS_PROTOCOL_PINS: Record<HarnessProtocol, { model: boolean; mode: boolean }> =
  Object.fromEntries(
    Object.entries(HARNESS_PROTOCOLS).map(([protocol, d]) => [protocol, d.pins]),
  ) as Record<HarnessProtocol, { model: boolean; mode: boolean }>;

/**
 * A cache of what the harness last advertised, not the truth. Once #58 lands, models and modes
 * come from the ACP handshake; this is the fallback shown before a harness has ever run.
 */
export const harnessCapabilitiesSchema = z
  .object({
    models: z.array(z.string().min(1)).default([]),
    modes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type HarnessCapabilities = z.infer<typeof harnessCapabilitiesSchema>;
export const DEFAULT_HARNESS_CAPABILITIES: HarnessCapabilities = { models: [], modes: [] };

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
 * holding the moment a second harness lands unless which variables to strip is *data* the guard
 * reads, not a constant it assumes.
 */
export const createHarnessCatalogEntryInput = z.object({
  key: catalogKey,
  displayName: z.string().min(1).max(120),
  protocol: harnessProtocolSchema,
  command: z.string().min(1),
  argsTemplate: z.array(z.string()).max(64).default([]),
  installHint: z.string().max(500).nullable().default(null),
  subscriptionEnvVar: envVarName,
  meteredEnvVar: envVarName,
  capabilities: harnessCapabilitiesSchema.default(DEFAULT_HARNESS_CAPABILITIES),
});
export type CreateHarnessCatalogEntryInput = z.infer<typeof createHarnessCatalogEntryInput>;

export const harnessCatalogEntryDto = z
  .object({
    id: idSchema,
    key: catalogKey,
    displayName: z.string(),
    protocol: harnessProtocolSchema,
    command: z.string(),
    argsTemplate: z.array(z.string()),
    installHint: z.string().nullable(),
    subscriptionEnvVar: z.string(),
    meteredEnvVar: z.string(),
    capabilities: harnessCapabilitiesSchema,
  })
  .merge(timestampsSchema);
export type HarnessCatalogEntryDto = z.infer<typeof harnessCatalogEntryDto>;

/** The row every Workspace is seeded with (`packages/db/src/seed.ts`, migration 0004). */
export const CLAUDE_CODE_CATALOG_KEY = "claude_code";

/**
 * The body of the orchestrator's `POST /probe-agent` — "does this Harness Profile actually work?",
 * asked before a Task is queued rather than discovered by one failing (2026-08-28).
 *
 * No `workspaceId`, for the same reason `announceRequest` omits one: it comes from the ticket's
 * signed claims, so a caller cannot probe into another tenant (Principle V). The Profile is
 * named because the credential is the Profile's — probing the catalog row alone would answer
 * "is the binary there" while leaving the half that usually breaks untested.
 */
export const harnessProbeRequest = z.object({
  ticket: z.string().min(1),
  agentProfileId: z.string().min(1),
});
export type HarnessProbeRequest = z.infer<typeof harnessProbeRequest>;

/**
 * What the probe found. `ok: false` is a finished answer, not an error — the whole point is to
 * turn "it does not work" into something an Owner can read and act on.
 */
export const harnessProbeReport = z.object({
  ok: z.boolean(),
  /** Why it failed, in terms an Owner can act on. Null when it worked. */
  reason: z.string().nullable(),
  /** The negotiated ACP version. Null for a protocol with no handshake to negotiate in. */
  protocolVersion: z.number().nullable(),
  /**
   * Authentication the harness offers. Non-empty is not a failure — it is how a harness says it
   * signs in its own way (opencode answers `["opencode-login"]`), which is worth showing next
   * to a green result rather than hiding behind one.
   */
  authMethods: z.array(z.string()),
  /** What it advertised, which is also what gets cached for the Profile form's pickers. */
  capabilities: z.object({ models: z.array(z.string()), modes: z.array(z.string()) }),
});
export type HarnessProbeReport = z.infer<typeof harnessProbeReport>;
