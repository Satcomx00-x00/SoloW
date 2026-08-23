import { describe, expect, it } from "bun:test";
import { type ClaudeUpdate, parseStreamLine, toUpdates } from "./events.js";

/** The shape the CLI actually emits for an assistant turn, trimmed to what we read. */
function assistantLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_01",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "done" }],
      usage: {
        input_tokens: 120,
        output_tokens: 34,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 2,
      },
      ...over,
    },
  });
}

function updatesFor(line: string): ClaudeUpdate[] {
  const event = parseStreamLine(line);
  expect(event).not.toBeNull();
  return event ? toUpdates(event) : [];
}

const usageOf = (updates: ClaudeUpdate[]) => updates.find((u) => u.kind === "usage");

describe("usage capture (issue #14)", () => {
  it("reads token counts and the model off a completed assistant turn", () => {
    const usage = usageOf(updatesFor(assistantLine()));
    expect(usage).toEqual({
      kind: "usage",
      messageId: "msg_01",
      reported: true,
      model: "claude-sonnet-4-20250514",
      inputTokens: 120,
      outputTokens: 34,
      cacheReadTokens: 8,
      cacheWriteTokens: 2,
    });
  });

  it("orders usage after the turn's own content, so the log reads as a narrative", () => {
    const updates = updatesFor(assistantLine());
    expect(updates.map((u) => u.kind)).toEqual(["text", "usage"]);
  });

  it("records a turn the CLI stated no usage for as a gap, not as a free turn", () => {
    // A turn with content but no `usage` key at all. Omitting it would make a provider that
    // quietly stops reporting usage look like a session that cost nothing.
    const updates = updatesFor(
      JSON.stringify({
        type: "assistant",
        message: { id: "msg_02", content: [{ type: "text", text: "hi" }] },
      }),
    );
    const usage = usageOf(updates);
    expect(usage?.reported).toBe(false);
    expect(usage?.inputTokens).toBe(0);
    expect(updates.map((u) => u.kind)).toEqual(["text", "usage"]);
  });

  it("treats individually missing counters as zero but still reports the turn", () => {
    const updates = updatesFor(assistantLine({ usage: { input_tokens: 5 } }));
    expect(usageOf(updates)).toEqual({
      kind: "usage",
      messageId: "msg_01",
      reported: true,
      model: "claude-sonnet-4-20250514",
      inputTokens: 5,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("survives a turn that states usage but no model — the model is unknown, not absent data", () => {
    const updates = updatesFor(assistantLine({ model: undefined }));
    expect(usageOf(updates)?.model).toBeNull();
  });

  it("carries no prompt or completion text on the usage update (Principle IV)", () => {
    const usage = usageOf(updatesFor(assistantLine()));
    expect(JSON.stringify(usage)).not.toContain("done");
  });

  it("does not let an unfamiliar usage field break the run", () => {
    const updates = updatesFor(
      assistantLine({ usage: { input_tokens: 1, some_future_counter: 99 } }),
    );
    expect(usageOf(updates)?.inputTokens).toBe(1);
  });
});

describe("one turn, many events (the over-counting trap)", () => {
  it("tags every block of a turn with the same message id, so a consumer can deduplicate", () => {
    // The CLI does not emit one event per turn. It emits one per content block and repeats
    // the whole turn's usage on each. Summing per event multiplies a turn's counts by its
    // block count — on a real transcript, 2.5x input and 5x output.
    const blocks = [
      { type: "thinking", thinking: "considering" },
      { type: "text", text: "here is the change" },
      { type: "tool_use", name: "edit_file" },
    ];
    const ids = blocks.map((block) => {
      const updates = updatesFor(assistantLine({ content: [block] }));
      return usageOf(updates)?.messageId;
    });

    expect(ids).toEqual(["msg_01", "msg_01", "msg_01"]);
  });

  it("carries a null id when the CLI states none, so the consumer can fall back", () => {
    const updates = updatesFor(assistantLine({ id: undefined }));
    expect(usageOf(updates)?.messageId).toBeNull();
  });
});

describe("tool calls and their results", () => {
  it("keeps the id and the arguments the CLI reported", () => {
    // Only the name used to survive, which is why a transcript could say "tool: Read" and
    // nothing more — and why a result could never be matched back to the call it belonged to.
    const updates = toUpdates({
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "src/a.ts" } },
        ],
      },
    });
    expect(updates.filter((u) => u.kind === "tool_use")).toEqual([
      { kind: "tool_use", name: "Read", callId: "toolu_01", input: { file_path: "src/a.ts" } },
    ]);
  });

  it("no longer drops the user event that carries a tool result", () => {
    // This path used to `return []` on the premise that results were "already summarised by the
    // tool_use above them". They were not, so `tool_result` had zero producers anywhere.
    expect(
      toUpdates({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "file contents" }],
        },
      }),
    ).toEqual([{ kind: "tool_result", callId: "toolu_01", ok: true, output: "file contents" }]);
  });

  it("reads a failed result as failed", () => {
    expect(
      toUpdates({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_02", is_error: true, content: "ENOENT" },
          ],
        },
      }),
    ).toEqual([{ kind: "tool_result", callId: "toolu_02", ok: false, output: "ENOENT" }]);
  });

  it("flattens a structured result to the text a transcript can show", () => {
    expect(
      toUpdates({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_03",
              content: [
                { type: "text", text: "line one\n" },
                { type: "text", text: "line two" },
              ],
            },
          ],
        },
      }),
    ).toEqual([
      { kind: "tool_result", callId: "toolu_03", ok: true, output: "line one\nline two" },
    ]);
  });

  it("keeps an unanticipated result shape rather than losing the fact a tool ran", () => {
    const [update] = toUpdates({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t4", content: { rows: 3 } }] },
    });
    expect(update).toMatchObject({ kind: "tool_result", callId: "t4", ok: true });
  });
});
