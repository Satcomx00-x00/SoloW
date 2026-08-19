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

  it("emits no usage when the CLI reported none, rather than inventing zeros", () => {
    // A turn with content but no `usage` key at all.
    const updates = updatesFor(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
    );
    expect(usageOf(updates)).toBeUndefined();
    expect(updates.map((u) => u.kind)).toEqual(["text"]);
  });

  it("treats individually missing counters as zero but still reports the turn", () => {
    const updates = updatesFor(assistantLine({ usage: { input_tokens: 5 } }));
    expect(usageOf(updates)).toEqual({
      kind: "usage",
      messageId: "msg_01",
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
