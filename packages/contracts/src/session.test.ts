import { describe, expect, it } from "bun:test";
import {
  parseSessionEventPayload,
  type SessionEventPayload,
  sessionEventPayloadSchema,
} from "./session.js";

/**
 * The session log's payload union (issue #2, AC-1) and the compatibility mapping that keeps
 * rows written before it existed readable. Both halves matter: a union nothing can round-trip
 * is not a contract, and a mapping that drops history takes the review gate's evidence with it.
 */

const VARIANTS: Array<[string, SessionEventPayload]> = [
  ["a user turn", { kind: "user_turn", text: "also add a test" }],
  ["an assistant turn", { kind: "assistant_turn", text: "patched latch.ts", thinking: false }],
  ["a thinking turn", { kind: "assistant_turn", text: "considering", thinking: true }],
  ["a notice", { kind: "notice", text: "\nmode: plan\n" }],
  ["a tool call", { kind: "tool_call", name: "Edit", callId: "call-1" }],
  [
    "a tool call from an adapter with no call ids",
    { kind: "tool_call", name: "Bash", callId: null },
  ],
  ["a tool result", { kind: "tool_result", callId: "call-1", ok: true }],
  [
    "a usage record",
    {
      kind: "usage",
      model: "claude-opus",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 8,
    },
  ],
  ["a state change", { kind: "state", from: "running", to: "review" }],
  [
    "a permission request",
    {
      kind: "permission_request",
      requestId: "req-1",
      title: "Write .env",
      toolKind: "edit",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    },
  ],
  [
    "a resolved permission",
    { kind: "permission_resolved", requestId: "req-1", optionId: "allow", decidedBy: "operator" },
  ],
  [
    "a captured diff",
    {
      kind: "diff",
      diffRef: "gatecontrol/task-1",
      files: [{ path: "src/latch.ts", status: "modified", additions: 3, deletions: 1 }],
      patch: "@@ -1 +1 @@",
      truncated: false,
    },
  ],
];

describe("sessionEventPayloadSchema", () => {
  for (const [name, payload] of VARIANTS) {
    it(`keeps ${name} intact through JSON and back`, () => {
      const stored = JSON.parse(JSON.stringify(sessionEventPayloadSchema.parse(payload)));
      expect(sessionEventPayloadSchema.parse(stored)).toEqual(payload);
    });
  }

  it("refuses a payload whose kind is not one the log records", () => {
    expect(sessionEventPayloadSchema.safeParse({ kind: "stdout", text: "hi" }).success).toBe(false);
  });

  it("refuses an assistant turn that does not say whether it was thinking", () => {
    // The distinction is the whole reason the variant carries the flag — a default would make a
    // reasoning line indistinguishable from an answer for every reader downstream.
    expect(
      sessionEventPayloadSchema.safeParse({ kind: "assistant_turn", text: "hi" }).success,
    ).toBe(false);
  });

  it("refuses a permission request with no request id to answer against", () => {
    expect(
      sessionEventPayloadSchema.safeParse({
        kind: "permission_request",
        requestId: "",
        title: "Write .env",
        toolKind: null,
        options: [],
      }).success,
    ).toBe(false);
  });
});

describe("parseSessionEventPayload (rows written before the union existed)", () => {
  it("reads a pre-union stdout row back as an assistant turn rather than refusing it", () => {
    expect(parseSessionEventPayload("stdout", { text: "patched latch.ts\n" })).toEqual({
      kind: "assistant_turn",
      text: "patched latch.ts\n",
      thinking: false,
    });
  });

  it("reads a pre-union tool_use row back as a tool call with no call id", () => {
    expect(parseSessionEventPayload("tool_use", { name: "Edit" })).toEqual({
      kind: "tool_call",
      name: "Edit",
      callId: null,
    });
  });

  it("reads a pre-union diff row back without disturbing its files or its patch", () => {
    // This is the "a Done Task can still show what was approved" property (Principle I): the
    // review page reads its diff out of this log and nothing rewrote the rows.
    const legacy = {
      diffRef: "gatecontrol/task-1",
      files: [{ path: "src/latch.ts", status: "modified" as const, additions: 3, deletions: 1 }],
      patch: "@@ -1 +1 @@",
      truncated: false,
      repositoryId: "repo-1",
      repositoryName: "service",
    };
    expect(parseSessionEventPayload("diff", legacy)).toEqual({ kind: "diff", ...legacy });
  });

  it("reads a pre-union permission request back as itself, options and all", () => {
    // Written by the ACP client (#58) before this union existed; the shapes match field for
    // field, so a reconnecting operator can still answer a question replayed from an old run.
    const legacy = {
      requestId: "req-1",
      title: "Write .env",
      toolKind: "edit",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    expect(parseSessionEventPayload("permission_request", legacy)).toEqual({
      kind: "permission_request",
      ...legacy,
    });
    expect(
      parseSessionEventPayload("permission_resolved", {
        requestId: "req-1",
        optionId: null,
        decidedBy: "policy",
      }),
    ).toEqual({
      kind: "permission_resolved",
      requestId: "req-1",
      optionId: null,
      decidedBy: "policy",
    });
  });

  it("falls back to a notice rather than throwing on a kind it has never seen", () => {
    // What the client's old `eventText()` did with anything it could not recognise, moved
    // server-side and made total: an unreadable row must not take the transcript with it.
    expect(parseSessionEventPayload("something_new", { odd: 1 })).toEqual({
      kind: "notice",
      text: '{"odd":1}',
    });
  });

  it("returns an already-typed payload untouched, whatever the column says", () => {
    const typed: SessionEventPayload = { kind: "user_turn", text: "steer left" };
    expect(parseSessionEventPayload("stdout", typed)).toEqual(typed);
  });
});
