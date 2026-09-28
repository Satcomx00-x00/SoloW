import { describe, expect, it } from "bun:test";
import type { SessionEventPayload } from "@solow/contracts";
import {
  canonicalJson,
  FORK_DIGEST_MAX_EVENTS,
  FORK_DIGEST_MAX_TURN_CHARS,
  hashSessionLog,
  planCompaction,
  renderForkDigest,
  type SessionLogEvent,
  sessionCursorAt,
  summarizeRange,
  verifySessionCursor,
} from "./session-log.js";

/**
 * The fork cursor's content addressing and what compaction is allowed to collapse (issue #2,
 * AC-3/AC-4). Both are pure, which is why they live here rather than in a data layer: the
 * refusals are the interesting part and they should be assertable without a database.
 */

const turn = (seq: number, text: string): SessionLogEvent => ({
  seq,
  payload: { kind: "assistant_turn", text, thinking: false },
});

const log = (n: number, from = 0): SessionLogEvent[] =>
  Array.from({ length: n }, (_, i) => turn(from + i, `line ${from + i}`));

describe("canonicalJson", () => {
  it("orders object keys so two spellings of the same value encode identically", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });

  it("leaves array order alone, because position is part of what an array means", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("hashSessionLog", () => {
  it("hashes the same log to the same digest regardless of payload key order", () => {
    // SQLite hands JSON back as text and a snapshot export may rewrite it; a cursor that
    // refused itself after a round trip through storage would be useless.
    const a: SessionLogEvent[] = [
      { seq: 0, payload: { kind: "tool_call", name: "Edit", callId: "c1" } },
    ];
    const b: SessionLogEvent[] = [
      { seq: 0, payload: { callId: "c1", name: "Edit", kind: "tool_call" } as SessionEventPayload },
    ];
    expect(hashSessionLog("sess-1", a)).toBe(hashSessionLog("sess-1", b));
  });

  it("changes the digest when any event in the range changes", () => {
    const before = log(3);
    const after = [...log(2), turn(2, "rewritten")];
    expect(hashSessionLog("sess-1", after)).not.toBe(hashSessionLog("sess-1", before));
  });

  it("changes the digest when an event is inserted, not only when one is edited", () => {
    expect(hashSessionLog("sess-1", log(4))).not.toBe(hashSessionLog("sess-1", log(3)));
  });

  it("hashes the stored payload rather than the shape a reader parsed out of it", () => {
    // A cursor claims the *row* has not been rewritten. The union strips keys it does not
    // declare, so digesting the parsed payload would let an UPDATE that only touched an
    // undeclared key pass as intact.
    const parsed: SessionEventPayload = { kind: "assistant_turn", text: "line 0", thinking: false };
    const intact: SessionLogEvent[] = [{ seq: 0, payload: parsed, stored: parsed }];
    const tampered: SessionLogEvent[] = [
      { seq: 0, payload: parsed, stored: { ...parsed, tampered: "yes" } },
    ];
    expect(hashSessionLog("sess-1", tampered)).not.toBe(hashSessionLog("sess-1", intact));
  });

  it("scopes the digest to the Session, so two logs that read alike are not interchangeable", () => {
    // Two runs of the same brief open with the same line. A cursor addresses one point in one
    // history, and a hash that ignored the Session id would let one redeem the other's.
    expect(hashSessionLog("sess-1", log(3))).not.toBe(hashSessionLog("sess-2", log(3)));
  });
});

describe("sessionCursorAt", () => {
  it("addresses the head of the log when no seq is named", () => {
    const cursor = sessionCursorAt("sess-1", log(3));
    expect(cursor?.seq).toBe(2);
    expect(cursor?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("covers only the events up to the seq it names", () => {
    const events = log(5);
    expect(sessionCursorAt("sess-1", events, 2)?.hash).toBe(hashSessionLog("sess-1", log(3)));
  });

  it("has no fork point to offer for an empty log", () => {
    expect(sessionCursorAt("sess-1", [])).toBeNull();
  });
});

describe("verifySessionCursor", () => {
  it("accepts a cursor whose history is intact", () => {
    const events = log(4);
    const cursor = sessionCursorAt("sess-1", events, 2);
    if (!cursor) throw new Error("expected a cursor");
    expect(verifySessionCursor(events, cursor)).toEqual({ ok: true });
  });

  it("accepts a cursor after the log grew past it — appending is not a rewrite", () => {
    const cursor = sessionCursorAt("sess-1", log(3), 2);
    if (!cursor) throw new Error("expected a cursor");
    expect(verifySessionCursor(log(8), cursor)).toEqual({ ok: true });
  });

  it("refuses a cursor whose history was rewritten underneath it", () => {
    const cursor = sessionCursorAt("sess-1", log(3), 2);
    if (!cursor) throw new Error("expected a cursor");
    const rewritten = [turn(0, "line 0"), turn(1, "something else"), turn(2, "line 2")];
    expect(verifySessionCursor(rewritten, cursor)).toEqual({
      ok: false,
      error: "cursor_hash_mismatch",
    });
  });

  it("refuses a cursor naming a seq the log does not have", () => {
    const cursor = sessionCursorAt("sess-1", log(5), 4);
    if (!cursor) throw new Error("expected a cursor");
    expect(verifySessionCursor(log(3), cursor)).toEqual({
      ok: false,
      error: "cursor_seq_unknown",
    });
  });
});

describe("planCompaction", () => {
  it("plans nothing for a session that has not got long yet", () => {
    expect(planCompaction(log(50), [], { threshold: 40, tail: 20 })).toEqual([]);
  });

  it("plans one closed range and leaves the tail the operator is reading alone", () => {
    const planned = planCompaction(log(100), [], { threshold: 40, tail: 20 });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.fromSeq).toBe(0);
    expect(planned[0]?.toSeq).toBe(79);
    expect(planned[0]?.eventCount).toBe(80);
  });

  it("never plans a range that overlaps one already recorded", () => {
    const planned = planCompaction(log(200), [{ fromSeq: 0, toSeq: 79 }], {
      threshold: 40,
      tail: 20,
    });
    expect(planned[0]?.fromSeq).toBe(80);
    expect(planned[0]?.toSeq).toBe(179);
  });

  it("stops a range before a summary recorded further along, rather than spanning it", () => {
    // The overlap the filter alone does not prevent: a recorded range in the *middle* of the log
    // leaves the uncovered candidates non-contiguous, and first-to-last would step straight over
    // it. Two readers take non-overlap on trust — the unique index cannot catch it, and the
    // workspace's grouping loop would drop the inner summary's disclosure.
    const planned = planCompaction(log(200), [{ fromSeq: 50, toSeq: 99 }], {
      threshold: 40,
      tail: 20,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.fromSeq).toBe(0);
    expect(planned[0]?.toSeq).toBe(49);
    expect(planned[0]?.eventCount).toBe(50);
  });

  it("plans nothing when the run before the next recorded range is shorter than the threshold", () => {
    // …and the threshold applies to what would actually be collapsed, not to everything that
    // happens to be unsummarised somewhere in the log.
    expect(
      planCompaction(log(200), [{ fromSeq: 30, toSeq: 99 }], { threshold: 40, tail: 20 }),
    ).toEqual([]);
  });

  it("plans nothing more once everything outside the tail is already summarised", () => {
    expect(
      planCompaction(log(100), [{ fromSeq: 0, toSeq: 79 }], { threshold: 40, tail: 20 }),
    ).toEqual([]);
  });
});

describe("summarizeRange", () => {
  it("summarises a range from the events themselves, naming the tools that ran", () => {
    const events: SessionLogEvent[] = [
      { seq: 0, payload: { kind: "user_turn", text: "fix the latch" } },
      turn(1, "on it"),
      { seq: 2, payload: { kind: "tool_call", name: "Read", callId: null } },
      { seq: 3, payload: { kind: "tool_call", name: "Edit", callId: null } },
      { seq: 4, payload: { kind: "state", from: "running", to: "review" } },
    ];
    expect(summarizeRange(events)).toBe(
      "5 events — 1 user turn, 1 assistant turn, 2 tool calls (Edit, Read), 1 state change",
    );
  });

  it("says the same thing twice for the same range, so a replayed step writes the same row", () => {
    const events = log(3);
    expect(summarizeRange(events)).toBe(summarizeRange([...events].reverse()));
  });
});

describe("renderForkDigest (issue #56, AC-3)", () => {
  const at = (seq: number, payload: SessionEventPayload): SessionLogEvent => ({ seq, payload });

  it("reads the work, in order, and leaves out the machinery and the private reasoning", () => {
    const digest = renderForkDigest([
      at(3, {
        kind: "tool_call",
        name: "Edit",
        input: {},
        status: "completed",
      } as SessionEventPayload),
      at(0, { kind: "user_turn", text: "Fix the latch" }),
      at(1, { kind: "assistant_turn", text: "weighing options", thinking: true }),
      at(2, { kind: "assistant_turn", text: "Rewiring it", thinking: false }),
      at(4, { kind: "notice", text: "Started a harness" }),
      at(5, {
        kind: "todos",
        items: [
          { content: "Order a servo", status: "completed" },
          { content: "Fit it", status: "pending" },
        ],
      }),
    ]);

    expect(digest.split("\n")).toEqual([
      "Operator: Fix the latch",
      "Agent: Rewiring it",
      "Tool: Edit",
      "Plan: [x] Order a servo; [ ] Fit it",
    ]);
  });

  it("keeps the tail nearest the fork point, and says how much it dropped", () => {
    const events = Array.from({ length: FORK_DIGEST_MAX_EVENTS + 5 }, (_, seq) =>
      at(seq, { kind: "assistant_turn", text: `line ${seq}`, thinking: false }),
    );
    const lines = renderForkDigest(events).split("\n");

    expect(lines[0]).toBe("[5 earlier events not shown]");
    expect(lines[1]).toBe("Agent: line 5");
    expect(lines.at(-1)).toBe(`Agent: line ${FORK_DIGEST_MAX_EVENTS + 4}`);
  });

  it("spends its budget on the work, so a burst of machinery before the fork cannot crowd it out", () => {
    // A run's last minutes are often nothing but notices and usage ticks. Counting those against
    // the cap would hand the child an empty history while dropping the work that preceded them.
    const events = [
      at(0, { kind: "user_turn", text: "Fix the latch" }),
      at(1, { kind: "assistant_turn", text: "Rewired it", thinking: false }),
      ...Array.from({ length: FORK_DIGEST_MAX_EVENTS + 10 }, (_, i) =>
        at(2 + i, { kind: "notice", text: `tick ${i}` }),
      ),
    ];

    expect(renderForkDigest(events).split("\n")).toEqual([
      "Operator: Fix the latch",
      "Agent: Rewired it",
    ]);
  });

  it("counts only what it would have shown when it says how much it dropped", () => {
    const events = [
      at(0, { kind: "notice", text: "machinery, never shown anyway" }),
      ...Array.from({ length: FORK_DIGEST_MAX_EVENTS + 1 }, (_, i) =>
        at(1 + i, { kind: "assistant_turn", text: `line ${i}`, thinking: false }),
      ),
    ];

    expect(renderForkDigest(events).split("\n")[0]).toBe("[1 earlier event not shown]");
  });

  it("names the files a diff touched", () => {
    const digest = renderForkDigest([
      at(0, {
        kind: "diff",
        files: [{ path: "src/latch.ts" }, { path: "src/servo.ts" }],
      } as SessionEventPayload),
      at(1, { kind: "diff", files: [{ path: "README.md" }] } as SessionEventPayload),
    ]);
    expect(digest.split("\n")).toEqual([
      "Diff: 2 files changed (src/latch.ts, src/servo.ts)",
      "Diff: 1 file changed (README.md)",
    ]);
  });

  it("prefers the harness's own summary of how it ended over the declared outcome", () => {
    const digest = renderForkDigest([
      at(0, {
        kind: "agent_done",
        changed: true,
        summary: "Servo fitted; latch holds",
        outcome: "changes_ready",
      } as SessionEventPayload),
      at(1, { kind: "agent_done", changed: false, outcome: "blocked" } as SessionEventPayload),
    ]);
    expect(digest.split("\n")).toEqual([
      "Agent finished: Servo fitted; latch holds",
      "Agent finished: blocked",
    ]);
  });

  it("clips one enormous turn rather than letting it crowd out the rest", () => {
    const digest = renderForkDigest([
      at(0, { kind: "user_turn", text: "x".repeat(FORK_DIGEST_MAX_TURN_CHARS + 50) }),
    ]);
    expect(digest).toBe(`Operator: ${"x".repeat(FORK_DIGEST_MAX_TURN_CHARS)}… [truncated]`);
  });

  it("says how a run ended even when the harness left no words", () => {
    const digest = renderForkDigest([
      at(0, { kind: "agent_done", changed: true, branch: "solow/task-1" } as SessionEventPayload),
    ]);
    expect(digest).toBe("Agent finished: with changes");
  });

  it("is the same text for the same log, whatever order the rows arrived in", () => {
    const a = at(0, { kind: "user_turn", text: "one" });
    const b = at(1, { kind: "assistant_turn", text: "two", thinking: false });
    expect(renderForkDigest([b, a])).toBe(renderForkDigest([a, b]));
  });
});
