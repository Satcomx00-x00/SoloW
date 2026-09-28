import { z } from "zod";

/**
 * ACP handshake negotiation (issue #58, AC-2 / risk R-2).
 *
 * The rule this module exists to enforce: **absent means unavailable**. An agent that did not
 * advertise a capability has not said "probably yes" — it has said nothing, and treating
 * silence as consent is how a client ends up sending a request the peer answers with an error
 * mid-run, or worse, one it half-implements. Every optional field below therefore defaults to
 * `false`, and every optional call site is guarded by `requireCapability`.
 */

/** The ACP major version SoloW speaks. */
export const ACP_PROTOCOL_VERSION = 1;

/**
 * The oldest version this client can still drive. A peer answering below it fails the run
 * naming both numbers, rather than guessing at an older wire shape and mis-parsing it.
 */
export const ACP_MIN_PROTOCOL_VERSION = 1;

/**
 * What SoloW advertises *as a client* — and it is deliberately almost nothing.
 *
 * ACP lets a client offer the agent a filesystem and a terminal to work through. SoloW
 * offers neither: the agent already runs inside its own git worktree, with its own tools, on
 * the Executor that Task selected (Principle II). Proxying `fs/write_text_file` through the
 * orchestrator would let an agent write anywhere the orchestrator can reach — outside the
 * worktree, outside the repository — for no benefit it does not already have.
 *
 * Advertising `false` is not decoration: `session.ts` answers any such incoming request with
 * `-32601`, which is the half of capability negotiation that actually protects something.
 */
export const SOLOW_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} as const;

/** The `initialize` result, read permissively — unknown fields are carried, not rejected. */
export const initializeResultSchema = z
  .object({
    protocolVersion: z.number().optional(),
    agentCapabilities: z
      .object({
        loadSession: z.boolean().optional(),
        promptCapabilities: z
          .object({
            image: z.boolean().optional(),
            audio: z.boolean().optional(),
            embeddedContext: z.boolean().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    authMethods: z.array(z.object({ id: z.string() }).passthrough()).optional(),
    /**
     * Who is answering, and which build. Optional in the spec and read permissively: a peer that
     * sends a malformed one has told us nothing, not something wrong.
     */
    agentInfo: z
      .object({ name: z.string().optional(), version: z.string().optional() })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

export type InitializeResult = z.infer<typeof initializeResultSchema>;

/** Everything the peer told us it can do, with every unstated answer read as `false`. */
export interface NegotiatedCapabilities {
  /** min(ours, theirs) — the version both sides can actually speak. */
  protocolVersion: number;
  loadSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
  /** Authentication methods the agent offers. Empty means it needs none from us. */
  authMethods: string[];
  /**
   * The `agentInfo` the peer sent, or null when it sent none. `version` is null when the peer
   * named itself but not its build — which, for a minimum-version check, is the same as silence.
   */
  agent: { name: string; version: string | null } | null;
}

export type AcpCapability = keyof Omit<
  NegotiatedCapabilities,
  "protocolVersion" | "authMethods" | "agent"
>;

/** Thrown when SoloW was about to use something the peer never advertised. */
export class CapabilityUnavailableError extends Error {
  constructor(readonly capability: string) {
    super(`the agent did not advertise the "${capability}" capability`);
    this.name = "CapabilityUnavailableError";
  }
}

/** Thrown when the peer speaks a version this client cannot drive. */
export class ProtocolVersionError extends Error {
  constructor(
    readonly theirs: number,
    readonly ours: number,
  ) {
    super(
      `agent speaks ACP protocol version ${theirs}; this client requires at least ` +
        `${ACP_MIN_PROTOCOL_VERSION} and speaks ${ours}`,
    );
    this.name = "ProtocolVersionError";
  }
}

/** The `initialize` params SoloW sends. */
export function initializeParams(): {
  protocolVersion: number;
  clientCapabilities: typeof SOLOW_CLIENT_CAPABILITIES;
} {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: SOLOW_CLIENT_CAPABILITIES,
  };
}

/**
 * Read an `initialize` result into a record of hard yes/no answers.
 *
 * A result that does not parse at all is treated as an agent that advertised nothing, not as a
 * failure: the run can still go ahead over the mandatory part of the protocol, and refusing
 * everything optional is exactly the safe posture. A *version* mismatch is different — that is
 * not a missing feature, it is a different wire format — so it throws.
 */
export function negotiate(result: unknown): NegotiatedCapabilities {
  const parsed = initializeResultSchema.safeParse(result);
  const data: InitializeResult = parsed.success ? parsed.data : {};

  // An agent that states no version is claiming ours; anything else negotiates down to the
  // lower of the two, because neither side can speak a version it does not implement.
  const theirs = data.protocolVersion ?? ACP_PROTOCOL_VERSION;
  if (theirs < ACP_MIN_PROTOCOL_VERSION)
    throw new ProtocolVersionError(theirs, ACP_PROTOCOL_VERSION);
  const prompt = data.agentCapabilities?.promptCapabilities;

  return {
    protocolVersion: Math.min(theirs, ACP_PROTOCOL_VERSION),
    loadSession: data.agentCapabilities?.loadSession === true,
    promptImage: prompt?.image === true,
    promptAudio: prompt?.audio === true,
    promptEmbeddedContext: prompt?.embeddedContext === true,
    authMethods: (data.authMethods ?? []).map((m) => m.id),
    agent: data.agentInfo
      ? { name: data.agentInfo.name ?? "", version: data.agentInfo.version?.trim() || null }
      : null,
  };
}

/**
 * A dotted version, read the way release tags are written: `1.18.33`, `v1.18.33`,
 * `1.18.33-beta.2`. Null for anything that is not one — a version this cannot read is not one
 * it can vouch for.
 */
function parseVersion(text: string): { parts: number[]; prerelease: boolean } | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match?.[1]) return null;
  return { parts: match[1].split(".").map(Number), prerelease: match[2] !== undefined };
}

/**
 * Whether `actual` is at least `minimum`. Numeric, part by part, a missing part counting as 0
 * (`1.18` is `1.18.0`). A pre-release of the minimum does **not** meet it: `1.18.33-beta` is the
 * build before `1.18.33`, and the minimum names the release whose behaviour was verified.
 * Anything unreadable on either side fails — a pin that passes on garbage is not a pin.
 */
export function meetsMinimumVersion(actual: string, minimum: string): boolean {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!a || !m) return false;
  const length = Math.max(a.parts.length, m.parts.length);
  for (let i = 0; i < length; i++) {
    const x = a.parts[i] ?? 0;
    const y = m.parts[i] ?? 0;
    if (x !== y) return x > y;
  }
  // The same numbers: a pre-release sits below its release, and a release meets its own number.
  return !a.prerelease || m.prerelease;
}

/** Whether a string is a version `meetsMinimumVersion` can read — what a pin is validated by. */
export function isReadableVersion(text: string): boolean {
  return parseVersion(text) !== null;
}

/**
 * Thrown when a harness is older than its catalog row's `minVersion`, or will not say which
 * version it is. The message is the Task's failure reason as the operator reads it, so it names
 * the harness, both versions, and what to do about it.
 */
export class HarnessVersionError extends Error {
  constructor(
    readonly harness: string,
    readonly actual: string | null,
    readonly minimum: string,
    readonly installHint: string | null = null,
  ) {
    const fix = installHint ? ` — upgrade it (${installHint})` : " — upgrade it";
    super(
      actual === null
        ? `could not confirm the ${harness} version: it did not report one, and this build needs at least ${minimum}${fix}`
        : `${harness} ${actual} is older than ${minimum}, the oldest version this build supports${fix}`,
    );
    this.name = "HarnessVersionError";
  }
}

/**
 * Refuse a harness below the catalog's minimum — straight after the handshake, before any
 * session exists. `harness` names it in the message: the catalog's display name, since that is
 * what the operator chose; the peer's own `agentInfo.name` is only the fallback.
 */
export function requireMinimumVersion(
  caps: NegotiatedCapabilities,
  minimum: string,
  opts: { harness?: string; installHint?: string | null } = {},
): void {
  const version = caps.agent?.version ?? null;
  const harness = opts.harness || caps.agent?.name || "the harness";
  if (version === null || !meetsMinimumVersion(version, minimum)) {
    throw new HarnessVersionError(harness, version, minimum, opts.installHint ?? null);
  }
}

/** Refuse to proceed with something the peer never advertised. */
export function requireCapability(caps: NegotiatedCapabilities, capability: AcpCapability): void {
  if (!caps[capability]) throw new CapabilityUnavailableError(capability);
}

/**
 * Refuse a prompt *before it is written* when it carries a content-block type the agent never
 * advertised.
 *
 * The alternative — send it and see — leaves the run half-committed: the agent has already
 * begun a turn it cannot complete, and the failure surfaces as an opaque protocol error rather
 * than as "this agent does not accept images".
 */
export function assertPromptBlocks(
  caps: NegotiatedCapabilities,
  blocks: ReadonlyArray<{ type: string }>,
): void {
  for (const block of blocks) {
    if (block.type === "image") requireCapability(caps, "promptImage");
    else if (block.type === "audio") requireCapability(caps, "promptAudio");
    else if (block.type === "resource" || block.type === "resource_link") {
      requireCapability(caps, "promptEmbeddedContext");
    }
  }
}
