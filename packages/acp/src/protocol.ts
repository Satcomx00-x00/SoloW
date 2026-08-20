import { z } from "zod";

/**
 * The ACP wire vocabulary GateControl acts on (Decision 0003).
 *
 * Written in the same permissive spirit as `packages/claude-code/src/events.ts`, and for the
 * same reason: the agent on the other end is a separate product on its own release cadence, so
 * every schema passes unknown fields through, an unrecognised update kind yields no updates
 * rather than throwing, and `stopReason` is read as a string rather than an enum. A protocol
 * revision that adds a field must not stop a run.
 *
 * The `AcpUpdate` union is deliberately parallel to `ClaudeUpdate`: both adapters flatten into
 * the same shapes, so the orchestrator maps them with two nearly identical switches instead of
 * growing a per-protocol notion of what an agent said.
 */

export const AcpMethod = {
  Initialize: "initialize",
  Authenticate: "authenticate",
  SessionNew: "session/new",
  SessionLoad: "session/load",
  SessionPrompt: "session/prompt",
  SessionCancel: "session/cancel",
  SessionSetMode: "session/set_mode",
  SessionUpdate: "session/update",
  SessionRequestPermission: "session/request_permission",
  FsReadTextFile: "fs/read_text_file",
  FsWriteTextFile: "fs/write_text_file",
  TerminalCreate: "terminal/create",
} as const;

/** Content blocks. Text is the only kind GateControl produces; the rest it only reads. */
export const contentBlockSchema = z.object({ type: z.string() }).passthrough();
const textContentSchema = z.object({ type: z.literal("text"), text: z.string() }).passthrough();

export const sessionNewResultSchema = z
  .object({
    sessionId: z.string(),
    modes: z
      .object({
        currentModeId: z.string().optional(),
        availableModes: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
      })
      .passthrough()
      .optional(),
    models: z
      .object({
        currentModelId: z.string().optional(),
        availableModels: z.array(z.object({ modelId: z.string() }).passthrough()),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const promptResultSchema = z.object({ stopReason: z.string().optional() }).passthrough();

/**
 * A `session/update` notification. `sessionUpdate` is the discriminator; everything under it
 * is shape-checked only where GateControl reads it.
 */
export const sessionNotificationSchema = z
  .object({
    sessionId: z.string().optional(),
    update: z.object({ sessionUpdate: z.string() }).passthrough(),
  })
  .passthrough();

export type SessionNotification = z.infer<typeof sessionNotificationSchema>;

const messageChunkSchema = z
  .object({ sessionUpdate: z.string(), content: contentBlockSchema })
  .passthrough();

const toolCallSchema = z
  .object({
    sessionUpdate: z.string(),
    toolCallId: z.string().optional(),
    title: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const modeUpdateSchema = z
  .object({ sessionUpdate: z.string(), currentModeId: z.string() })
  .passthrough();

/**
 * A permission request from the agent (`session/request_permission`).
 *
 * `toolCall.rawInput` is present on the wire and is deliberately *not* modelled: the raw input
 * of a tool call can carry the contents of a file being written, which can carry a credential.
 * GateControl surfaces the title, the kind and the options — enough for an operator to decide
 * — and never puts the raw input on its own wire or in a log (Principle IV).
 */
export const permissionRequestSchema = z
  .object({
    sessionId: z.string().optional(),
    toolCall: z
      .object({
        toolCallId: z.string().optional(),
        title: z.string().optional(),
        kind: z.string().optional(),
      })
      .passthrough()
      .optional(),
    options: z
      .array(
        z
          .object({
            optionId: z.string(),
            name: z.string().optional(),
            kind: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/** One permission option, as the agent offered it. GateControl never invents one. */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  /** `allow_once`, `allow_always`, `reject_once`, `reject_always`, or whatever the agent says. */
  kind: string;
}

/** What GateControl does with an ACP session, flattened out of the protocol's shapes. */
export type AcpUpdate =
  | { kind: "session"; sessionId: string; cwd: string }
  | { kind: "text"; channel: "assistant" | "thinking" | "user"; text: string }
  | { kind: "tool_call"; name: string; toolCallId: string | null; status: string | null }
  | { kind: "mode"; modeId: string }
  /**
   * One completed prompt turn's usage (issue #14).
   *
   * ACP v1 defines no token-accounting field, so `reported` is always false here and the counts
   * are always zero. Emitting the turn anyway is the point: issue #14's invariant is that a turn
   * the agent said nothing about is still recorded, so the gap is visible instead of looking
   * like a turn that cost nothing. Fabricating an estimate would be worse than admitting it.
   */
  | {
      kind: "usage";
      messageId: string | null;
      reported: boolean;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | { kind: "result"; ok: boolean; stopReason: string | null; error: string | null };

/** The prompt content blocks for a plain text turn — the only shape GateControl sends. */
export function textPrompt(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

/**
 * Flatten one `session/update` notification into the updates GateControl streams and logs.
 *
 * An unrecognised `sessionUpdate` yields nothing rather than throwing — a newer agent emitting
 * a kind this build has never heard of should be quiet, not fatal.
 */
export function toUpdates(params: unknown): AcpUpdate[] {
  const parsed = sessionNotificationSchema.safeParse(params);
  if (!parsed.success) return [];
  const update = parsed.data.update;

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      const chunk = messageChunkSchema.safeParse(update);
      if (!chunk.success) return [];
      const text = textContentSchema.safeParse(chunk.data.content);
      // A non-text block (an image, an embedded resource) is dropped rather than stringified:
      // a terminal showing `[object Object]` is worse than a terminal showing nothing.
      if (!text.success) return [];
      const channel =
        update.sessionUpdate === "agent_thought_chunk"
          ? "thinking"
          : update.sessionUpdate === "user_message_chunk"
            ? "user"
            : "assistant";
      return [{ kind: "text", channel, text: text.data.text }];
    }
    case "tool_call":
    case "tool_call_update": {
      const call = toolCallSchema.safeParse(update);
      if (!call.success) return [];
      return [
        {
          kind: "tool_call",
          // The title is what the agent means the operator to read; the id is the correlation
          // key. Neither is the tool's raw input, which never leaves the agent process.
          name: call.data.title ?? call.data.kind ?? "tool",
          toolCallId: call.data.toolCallId ?? null,
          status: call.data.status ?? null,
        },
      ];
    }
    case "current_mode_update": {
      const mode = modeUpdateSchema.safeParse(update);
      if (!mode.success) return [];
      return [{ kind: "mode", modeId: mode.data.currentModeId }];
    }
    default:
      return [];
  }
}
