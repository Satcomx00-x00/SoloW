/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { SessionEventDto, TaskEvent } from "@solow/contracts";
import {
  agentActivity,
  buildTranscript,
  openPermission,
  type TextRow,
  type ToolRow,
} from "./transcript";

/**
 * The transcript model. These are the rules that used to be absent entirely — the old terminal
 * concatenated every source into one string and hoped.
 */

const persisted = (
  seq: number,
  payload: SessionEventDto["payload"],
  sessionId = "s1",
): SessionEventDto =>
  ({ id: `e${seq}`, sessionId, seq, kind: payload.kind, payload, at: "" }) as SessionEventDto;

const liveText = (
  seq: number,
  text: string,
  channel: TaskEvent extends { channel: infer C } ? C : never = "assistant" as never,
  sessionId = "s1",
): TaskEvent => ({ kind: "stdout", taskId: "t1", sessionId, seq, text, channel }) as TaskEvent;

describe("buildTranscript", () => {
  it("shows an event once when the query and the replay both deliver it", () => {
    // The stream replays from the beginning on its first connection, so every event of an
    // already-started task arrives twice. The old terminal rendered both copies.
    const rows = buildTranscript(
      [persisted(0, { kind: "assistant_turn", text: "hello", thinking: false })],
      [liveText(0, "hello")],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as TextRow).text).toBe("hello");
  });

  it("merges consecutive chunks of one turn into a single block", () => {
    // Markdown cannot be parsed on a fragment: a half-arrived fence would swallow the rest of
    // the transcript. The renderer must see turns, not deltas.
    const rows = buildTranscript([], [liveText(0, "# Title\n"), liveText(1, "body text")]);
    expect(rows).toHaveLength(1);
    expect((rows[0] as TextRow).text).toBe("# Title\nbody text");
  });

  it("does not merge across a channel change", () => {
    const rows = buildTranscript(
      [],
      [liveText(0, "answer"), liveText(1, "thought", "thinking" as never), liveText(2, "more")],
    );
    expect(rows.map((r) => (r as TextRow).channel)).toEqual(["assistant", "thinking", "assistant"]);
  });

  it("does not merge two turns that a tool call came between", () => {
    const rows = buildTranscript(
      [
        persisted(0, { kind: "assistant_turn", text: "before", thinking: false }),
        persisted(1, { kind: "tool_call", name: "Read", callId: "c1", input: null }),
        persisted(2, { kind: "assistant_turn", text: "after", thinking: false }),
      ],
      [],
    );
    expect(rows.map((r) => r.kind)).toEqual(["text", "tool", "text"]);
  });

  it("folds a call, its status update and its result into one row", () => {
    const rows = buildTranscript(
      [
        persisted(0, {
          kind: "tool_call",
          name: "Read",
          callId: "c1",
          input: { file_path: "a.ts" },
          status: "in_progress",
        }),
        persisted(1, {
          kind: "tool_call",
          name: "Read",
          callId: "c1",
          input: null,
          status: "completed",
        }),
        persisted(2, {
          kind: "tool_result",
          callId: "c1",
          ok: true,
          output: "contents",
          truncated: false,
        }),
      ],
      [],
    );
    expect(rows).toHaveLength(1);
    const tool = rows[0] as ToolRow;
    expect(tool.name).toBe("Read");
    expect(tool.input).toEqual({ file_path: "a.ts" });
    expect(tool.result).toEqual({ ok: true, output: "contents", truncated: false });
    expect(tool.status).toBe("completed");
  });

  it("keeps two interleaved calls apart", () => {
    const rows = buildTranscript(
      [
        persisted(0, { kind: "tool_call", name: "Read", callId: "c1", input: null }),
        persisted(1, { kind: "tool_call", name: "Bash", callId: "c2", input: null }),
        persisted(2, {
          kind: "tool_result",
          callId: "c2",
          ok: false,
          output: "boom",
          truncated: false,
        }),
      ],
      [],
    );
    expect(rows).toHaveLength(2);
    expect((rows[0] as ToolRow).result).toBeNull();
    expect((rows[1] as ToolRow).result?.ok).toBe(false);
  });

  it("does not fold two calls that merely share an id across sessions", () => {
    // `seq` and tool ids both restart per session, so a bare id would merge two unrelated calls
    // from different review rounds into one row and silently rewrite history for a reviewer.
    const rows = buildTranscript(
      [
        persisted(0, { kind: "tool_call", name: "Read", callId: "c1", input: null }, "s1"),
        persisted(0, { kind: "tool_call", name: "Read", callId: "c1", input: null }, "s2"),
      ],
      [],
    );
    expect(rows).toHaveLength(2);
  });

  it("gives a call with no id its own row rather than merging it with an unrelated one", () => {
    const rows = buildTranscript(
      [
        persisted(0, { kind: "tool_call", name: "Read", callId: null, input: null }),
        persisted(1, { kind: "tool_call", name: "Bash", callId: null, input: null }),
      ],
      [],
    );
    expect(rows).toHaveLength(2);
  });

  it("marks only the last text block as still open, so settled blocks can be memoized", () => {
    const rows = buildTranscript(
      [],
      [liveText(0, "one"), liveText(1, "x", "user" as never), liveText(2, "two")],
    );
    const texts = rows.filter((r): r is TextRow => r.kind === "text");
    expect(texts.map((t) => t.open)).toEqual([false, false, true]);
  });

  it("settles a permission in place, so the transcript records the question and the answer", () => {
    const rows = buildTranscript(
      [
        persisted(0, {
          kind: "permission_request",
          requestId: "r1",
          title: "Write .env",
          toolKind: "edit",
          options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
        }),
        persisted(1, {
          kind: "permission_resolved",
          requestId: "r1",
          optionId: "once",
          decidedBy: "operator",
        }),
      ],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(openPermission(rows)).toBeNull();
  });

  it("reports an unanswered permission as open, which is what makes the widget interactive", () => {
    const rows = buildTranscript(
      [
        persisted(0, {
          kind: "permission_request",
          requestId: "r1",
          title: "Run rm -rf",
          toolKind: "execute",
          options: [{ optionId: "no", name: "Deny", kind: "reject_once" }],
        }),
      ],
      [],
    );
    expect(openPermission(rows)?.requestId).toBe("r1");
  });

  it("keeps sessions in the order they appear, not interleaved by seq", () => {
    // `seq` restarts per session; sorting on it globally would shuffle review rounds together.
    const rows = buildTranscript(
      [
        persisted(0, { kind: "assistant_turn", text: "round one", thinking: false }, "s1"),
        persisted(0, { kind: "assistant_turn", text: "round two", thinking: false }, "s2"),
      ],
      [],
    );
    expect(rows.map((r) => (r as TextRow).text)).toEqual(["round one", "round two"]);
  });
});

describe("agentActivity", () => {
  const running = (rows: Parameters<typeof agentActivity>[0]) => agentActivity(rows, true);

  it("says nothing at all when no agent is running", () => {
    // A finished run is a record. A line under it claiming the agent is thinking would be false,
    // and it would be false under every finished run in the product.
    expect(agentActivity(buildTranscript([], [liveText(0, "done")]), false)).toBeNull();
  });

  it("reports the launch while a running task has produced nothing", () => {
    // The window the operator most needs a word for: they pressed Launch and the panel has not
    // changed since. It used to advise them to launch the task.
    expect(running([])).toEqual({ kind: "launching" });
  });

  it("names the tool a call is still inside", () => {
    // "Working…" would not tell an operator that the agent has been in Bash for ninety seconds,
    // which is the thing worth knowing.
    const rows = buildTranscript(
      [persisted(0, { kind: "tool_call", name: "Bash", callId: "c1", input: null })],
      [],
    );
    expect(running(rows)).toEqual({ kind: "tool", name: "Bash" });
  });

  it("stops naming a tool once its result has landed", () => {
    const rows = buildTranscript(
      [
        persisted(0, { kind: "tool_call", name: "Bash", callId: "c1", input: null }),
        persisted(1, { kind: "tool_result", callId: "c1", ok: true, output: "ok" }),
      ],
      [],
    );
    expect(running(rows)).toEqual({ kind: "thinking" });
  });

  it("distinguishes a turn still arriving from a model composing one", () => {
    expect(running(buildTranscript([], [liveText(0, "the answer is")]))).toEqual({
      kind: "writing",
    });
    expect(running(buildTranscript([], [liveText(0, "hmm", "thinking" as never)]))).toEqual({
      kind: "thinking",
    });
  });

  it("goes quiet while the agent is blocked on a question", () => {
    // The permission card already says what is happening, and the agent is not thinking — it is
    // waiting for a human. Two different claims, and only one of them is true.
    const rows = buildTranscript(
      [
        persisted(0, {
          kind: "permission_request",
          requestId: "r1",
          title: "Run rm -rf",
          toolKind: "execute",
          toolCallId: null,
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        }),
      ],
      [],
    );
    expect(running(rows)).toBeNull();
  });

  it("resumes once that question is answered", () => {
    const rows = buildTranscript(
      [
        persisted(0, {
          kind: "permission_request",
          requestId: "r1",
          title: "Run rm -rf",
          toolKind: "execute",
          toolCallId: null,
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        }),
        persisted(1, {
          kind: "permission_resolved",
          requestId: "r1",
          optionId: "allow",
          decidedBy: "operator",
        }),
      ],
      [],
    );
    expect(running(rows)).toEqual({ kind: "thinking" });
  });
});
