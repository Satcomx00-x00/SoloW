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
}

export type AcpCapability = keyof Omit<NegotiatedCapabilities, "protocolVersion" | "authMethods">;

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
  };
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
