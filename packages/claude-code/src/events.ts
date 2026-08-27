import { z } from "zod";

/**
 * Claude Code's headless stream-JSON protocol (`claude -p --output-format stream-json`).
 *
 * One JSON object per line on stdout. This models only the parts SoloW acts on and is
 * deliberately permissive everywhere else: the CLI is a separate product on its own release
 * cadence, and a field appearing that we did not anticipate must not stop a run. Anything
 * unrecognised parses to `null` and is skipped rather than throwing.
 */

/** Blocks inside an assistant message. Text and tool use are the two we surface. */
const textBlockSchema = z.object({ type: z.literal("text"), text: z.string() });
const thinkingBlockSchema = z.object({ type: z.literal("thinking"), thinking: z.string() });
const toolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().optional(),
  name: z.string(),
  input: z.unknown().optional(),
});
/**
 * A tool's result, as it comes back on a `user` event.
 *
 * `content` is whatever the tool produced: a string for most, an array of blocks for the ones
 * that return structured output. Both shapes are accepted and flattened to text by the mapper,
 * because a transcript renders text — and because refusing an unanticipated shape would drop
 * the result entirely rather than showing a truncated version of it.
 */
const toolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().optional(),
  is_error: z.boolean().optional(),
  content: z.unknown().optional(),
});

/** Anything else: recognised as a block, carried no further. */
const contentBlockSchema = z.object({ type: z.string() }).passthrough();

/**
 * The session preamble. `cwd` is the load-bearing field: with `--worktree`, this is the
 * worktree Claude Code created, and it is how SoloW learns where the agent is working
 * without having to guess a naming convention.
 */
export const initEventSchema = z
  .object({
    type: z.literal("system"),
    subtype: z.literal("init"),
    cwd: z.string().optional(),
    session_id: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough();

/**
 * Token usage, as the CLI reports it on each assistant message.
 *
 * Every field is optional: usage is the CLI's to report, not ours to require, and a release
 * that renames or drops one must not stop a run. A turn whose usage cannot be read is still
 * recorded — as a turn with nothing reported — so a coverage gap is visible rather than
 * indistinguishable from a turn that genuinely cost nothing.
 */
export const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  })
  .passthrough();

export const assistantEventSchema = z
  .object({
    type: z.literal("assistant"),
    message: z
      .object({
        /**
         * Identifies the *turn*. The CLI emits one assistant event per content block and
         * repeats the whole message's usage on each, so this — not the event — is the unit
         * a usage record corresponds to.
         */
        id: z.string().optional(),
        content: z.array(contentBlockSchema).optional(),
        model: z.string().optional(),
        usage: usageSchema.optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const userEventSchema = z
  .object({
    type: z.literal("user"),
    message: z
      .object({ content: z.array(contentBlockSchema).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * The terminal event of a run. `is_error` is what decides whether the Task failed; `subtype`
 * carries why. `result` is the assistant's closing text.
 */
export const resultEventSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
    total_cost_usd: z.number().optional(),
    num_turns: z.number().optional(),
  })
  .passthrough();

export const streamEventSchema = z.union([
  initEventSchema,
  assistantEventSchema,
  userEventSchema,
  resultEventSchema,
  // A `system` event that is not `init`, or any future type: shape-checked only.
  z.object({ type: z.string() }).passthrough(),
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
export type InitEvent = z.infer<typeof initEventSchema>;
export type ResultEvent = z.infer<typeof resultEventSchema>;

/** What SoloW does with a stream event, flattened out of the CLI's message shapes. */
export type ClaudeUpdate =
  | { kind: "session"; cwd: string | null; sessionId: string | null }
  | { kind: "text"; channel: "assistant" | "thinking"; text: string }
  /**
   * A tool invocation. `callId` is the CLI's own id for it — without it a result cannot be
   * matched back to its call, which is why the transcript could only ever say "tool: Read".
   *
   * `input` is the tool's raw arguments, passed on as the CLI reported them. Narrowing them to
   * what is safe to store is deliberately NOT done here: this package models the protocol, and
   * the allowlist is a policy that must apply to every adapter, so it lives once in the
   * orchestrator (`task-run.ts`) where both this and ACP pass through it.
   */
  | { kind: "tool_use"; name: string; callId: string | null; input: unknown }
  /** How a tool call finished. `output` is flattened to text; truncation is the orchestrator's. */
  | { kind: "tool_result"; callId: string | null; ok: boolean; output: string | null }
  /**
   * One completed assistant turn's token usage (issue #14).
   *
   * Deliberately carries counts and a model, never content, and no monetary figure: cost is
   * derived from these at query time so a price change can never rewrite recorded history.
   */
  | {
      kind: "usage";
      /**
       * The assistant message this usage belongs to. The CLI repeats identical usage on every
       * content block of one turn, so consumers MUST deduplicate on this: summing per event
       * over-counts a multi-block turn by its block count.
       */
      messageId: string | null;
      /**
       * False when the CLI completed a turn but stated no usage for it.
       *
       * The turn still happened and still cost something, so it is reported as a turn with
       * nothing known rather than omitted — an omitted turn is indistinguishable from a free
       * one, and a provider that quietly stops reporting usage would otherwise make a whole
       * session look costless.
       */
      reported: boolean;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }
  | { kind: "result"; ok: boolean; subtype: string | null; text: string | null };

/** Parse one stdout line. Returns null for blank lines and anything unparseable. */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // The CLI writes diagnostics to stderr, but a stray non-JSON line on stdout must not end
    // a run that is otherwise fine.
    return null;
  }
  const parsed = streamEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Flatten one stream event into the updates SoloW streams and logs. */
export function toUpdates(event: StreamEvent): ClaudeUpdate[] {
  if (event.type === "system") {
    const init = initEventSchema.safeParse(event);
    if (!init.success) return [];
    return [
      { kind: "session", cwd: init.data.cwd ?? null, sessionId: init.data.session_id ?? null },
    ];
  }

  if (event.type === "assistant") {
    const parsed = assistantEventSchema.safeParse(event);
    if (!parsed.success) return [];
    const updates: ClaudeUpdate[] = [];
    for (const block of parsed.data.message.content ?? []) {
      // Narrowed per block rather than off the union: the catch-all member is a passthrough
      // object, which widens every field to `unknown` for the whole union.
      const text = textBlockSchema.safeParse(block);
      if (text.success) {
        updates.push({ kind: "text", channel: "assistant", text: text.data.text });
        continue;
      }
      const thinking = thinkingBlockSchema.safeParse(block);
      if (thinking.success) {
        updates.push({ kind: "text", channel: "thinking", text: thinking.data.thinking });
        continue;
      }
      const tool = toolUseBlockSchema.safeParse(block);
      if (tool.success) {
        updates.push({
          kind: "tool_use",
          name: tool.data.name,
          callId: tool.data.id ?? null,
          input: tool.data.input,
        });
      }
    }
    // Usage last: it belongs to the turn these blocks just completed, and ordering it after
    // them keeps the event log readable as a narrative.
    //
    // Emitted whether or not the CLI stated usage. A turn it said nothing about is reported
    // with `reported: false` and zero counts, so the gap is visible downstream instead of
    // looking like a turn that cost nothing.
    const usage = parsed.data.message.usage;
    updates.push({
      kind: "usage",
      messageId: parsed.data.message.id ?? null,
      reported: usage !== undefined,
      model: parsed.data.message.model ?? null,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    });
    return updates;
  }

  if (event.type === "result") {
    const parsed = resultEventSchema.safeParse(event);
    if (!parsed.success) return [];
    return [
      {
        kind: "result",
        // Absent `is_error` means success: the CLI omits it on a clean run.
        ok: parsed.data.is_error !== true,
        subtype: parsed.data.subtype ?? null,
        text: parsed.data.result ?? null,
      },
    ];
  }

  if (event.type === "user") {
    // This used to `return []` on the premise that a `user` event's tool results were "already
    // summarised by the tool_use above them". They were not: that `tool_use` carried only a
    // name, so nothing in the system ever recorded whether a tool succeeded, failed, or what it
    // produced — and `session_event`'s `tool_result` member had zero producers as a result.
    const parsed = userEventSchema.safeParse(event);
    if (!parsed.success) return [];
    const updates: ClaudeUpdate[] = [];
    for (const block of parsed.data.message?.content ?? []) {
      const result = toolResultBlockSchema.safeParse(block);
      if (!result.success) continue;
      updates.push({
        kind: "tool_result",
        callId: result.data.tool_use_id ?? null,
        // `is_error` absent means the tool did not report a failure, which is the success case.
        ok: result.data.is_error !== true,
        output: flattenToolOutput(result.data.content),
      });
    }
    return updates;
  }

  return [];
}

/**
 * A tool result's `content` as text.
 *
 * The CLI sends a bare string for most tools and an array of `{type:"text",text}` blocks for the
 * ones with structured output. Anything else is JSON-stringified rather than dropped: a reader
 * seeing an odd-looking result is better served than one seeing nothing, and this is the only
 * record that a tool produced anything at all.
 */
function flattenToolOutput(content: unknown): string | null {
  if (content === undefined || content === null) return null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        const text = textBlockSchema.safeParse(block);
        return text.success ? text.data.text : null;
      })
      .filter((t): t is string => t !== null);
    if (parts.length > 0) return parts.join("");
  }
  return JSON.stringify(content);
}

/** One line of stream-JSON input: a user turn, as the CLI expects it. */
export function encodeUserTurn(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}
