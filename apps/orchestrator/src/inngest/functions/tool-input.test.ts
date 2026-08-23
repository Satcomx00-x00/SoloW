/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { allowlistToolInput, readTodoWrite, toolStatus, truncateToolOutput } from "./task-run.js";

/**
 * The per-tool argument allowlist (Principle IV).
 *
 * `tool_call.input` was declared and left unpopulated for a long time precisely because a tool's
 * raw input can hold the contents of a file being written. These tests are the proof that
 * populating it did not reopen that hole.
 */

describe("allowlistToolInput", () => {
  it("keeps the argument that says WHICH — the whole point of showing a tool call", () => {
    expect(allowlistToolInput("Read", { file_path: "src/latch.ts" })).toEqual({
      file_path: "src/latch.ts",
    });
    expect(allowlistToolInput("Bash", { command: "bun run typecheck" })).toEqual({
      command: "bun run typecheck",
    });
    expect(allowlistToolInput("Grep", { pattern: "deleteTask", path: "src" })).toEqual({
      pattern: "deleteTask",
      path: "src",
    });
  });

  it("never stores the contents of a file being written", () => {
    // The two keys this whole mechanism exists to exclude. If either ever appears in the output
    // of this function, a credential pasted into a file reaches the durable log.
    expect(allowlistToolInput("Write", { file_path: "a.ts", content: "sk-ant-SECRET" })).toEqual({
      file_path: "a.ts",
    });
    expect(allowlistToolInput("Edit", { file_path: "a.ts", new_string: "sk-ant-SECRET" })).toEqual({
      file_path: "a.ts",
    });
  });

  it("fails closed for a tool it does not know", () => {
    // A denylist would fail open here: a tool added upstream with a new content-bearing argument
    // would start leaking the day it shipped. An unknown tool contributes nothing at all.
    expect(allowlistToolInput("SomeFutureTool", { anything: "at all", secret: "x" })).toBeNull();
  });

  it("cuts a long argument, because a command is a line and not a file", () => {
    const long = "x".repeat(1_000);
    const out = allowlistToolInput("Bash", { command: long });
    expect(out?.["command"]?.length).toBeLessThan(long.length);
    expect(out?.["command"]?.endsWith("…")).toBe(true);
  });

  it("distinguishes 'no arguments recorded' from 'recorded, and there were none'", () => {
    expect(allowlistToolInput("Read", {})).toBeNull();
    expect(allowlistToolInput("Read", null)).toBeNull();
    expect(allowlistToolInput("Read", "not an object")).toBeNull();
  });

  it("stringifies a non-string argument rather than dropping it", () => {
    expect(allowlistToolInput("Read", { file_path: "a.ts", limit: 20 })).toEqual({
      file_path: "a.ts",
      limit: "20",
    });
  });
});

describe("truncateToolOutput", () => {
  it("passes a short result through untouched", () => {
    expect(truncateToolOutput("applied")).toEqual({ output: "applied", truncated: false });
  });

  it("cuts a long result and says that it did", () => {
    // Compaction will not save the log from an untruncated Read: it counts events, not bytes,
    // and only runs at a review-round boundary.
    const { output, truncated } = truncateToolOutput("y".repeat(10_000));
    expect(truncated).toBe(true);
    expect(output?.length).toBeLessThan(10_000);
  });

  it("carries a missing result as missing", () => {
    expect(truncateToolOutput(null)).toEqual({ output: null, truncated: false });
  });
});

describe("toolStatus", () => {
  it("accepts the statuses the log can store", () => {
    expect(toolStatus("in_progress")).toBe("in_progress");
    expect(toolStatus("failed")).toBe("failed");
  });

  it("drops a status it cannot render rather than storing it raw", () => {
    // ACP's status is a free-form string. A future vocabulary must not be able to widen the
    // persisted union by writing into it.
    expect(toolStatus("some_future_status")).toBeNull();
    expect(toolStatus(null)).toBeNull();
  });
});

/**
 * Reading the agent's plan out of a `TodoWrite` call (`readTodoWrite`).
 *
 * This function decides whether a plan reaches the durable log or is replaced by the
 * contentless `tool_call` row that recording it exists to abolish, so both directions are
 * pinned here: a list that overshoots the schema's bounds must still be *kept* — cut down —
 * while a payload that is not a todo list at all must be refused so the caller can fall back.
 */
describe("readTodoWrite", () => {
  it("reads a well-formed list, keeping the present-tense form the agent renders", () => {
    expect(
      readTodoWrite({
        todos: [
          { content: "Add the todos variant", status: "completed", activeForm: "Adding it" },
          { content: "Wire the emit site", status: "in_progress", activeForm: "Wiring it" },
          { content: "Write the tests", status: "pending", activeForm: "Writing them" },
        ],
      }),
    ).toEqual([
      { content: "Add the todos variant", status: "completed", activeForm: "Adding it" },
      { content: "Wire the emit site", status: "in_progress", activeForm: "Wiring it" },
      { content: "Write the tests", status: "pending", activeForm: "Writing them" },
    ]);
  });

  it("accepts an item that carries no active form, and drops keys the schema does not name", () => {
    expect(readTodoWrite({ todos: [{ content: "Ship it", status: "pending", id: 7 }] })).toEqual([
      { content: "Ship it", status: "pending" },
    ]);
  });

  it("reads an emptied list as an empty list, not as a missing one", () => {
    // An agent that finished its plan clears it. That is a fact about the run and has to be
    // distinguishable from a payload this function could not read — the caller emits one and
    // falls back for the other.
    expect(readTodoWrite({ todos: [] })).toEqual([]);
  });

  it("refuses anything that is not a todo list, so the caller can fall back to the tool call", () => {
    // Every one of these has to return null rather than throw or half-parse: a `TodoWrite` this
    // build cannot read must still reach the transcript as the tool call it always was.
    expect(readTodoWrite({ todos: "add tests" })).toBeNull();
    expect(readTodoWrite({ todos: [{ content: "no status" }] })).toBeNull();
    expect(readTodoWrite({ todos: [{ content: "", status: "pending" }] })).toBeNull();
    expect(readTodoWrite({ todos: [{ content: "x", status: "abandoned" }] })).toBeNull();
    expect(readTodoWrite({ todos: [null] })).toBeNull();
    expect(readTodoWrite({ file_path: "a.ts" })).toBeNull();
    expect(readTodoWrite(null)).toBeNull();
    expect(readTodoWrite("todos")).toBeNull();
  });

  it("cuts an over-long list down to the bound instead of refusing it", () => {
    // Refusing here would be the worst of both outcomes: the plan lost *and* the contentless
    // row back in the transcript. The log is the record that outlives the run, so the list is
    // bounded on the way in and what fits is kept.
    const items = readTodoWrite({
      todos: Array.from({ length: 150 }, (_, i) => ({
        content: `${i}-${"x".repeat(2_000)}`,
        status: "pending" as const,
        activeForm: "y".repeat(2_000),
      })),
    });
    expect(items).toHaveLength(100);
    expect(items?.[0]?.content).toHaveLength(500);
    expect(items?.[0]?.content.endsWith("…")).toBe(true);
    expect(items?.[0]?.activeForm).toHaveLength(500);
  });

  it("leaves a list that is already within the bounds untouched", () => {
    const content = "z".repeat(500);
    expect(readTodoWrite({ todos: [{ content, status: "pending" }] })).toEqual([
      { content, status: "pending" },
    ]);
  });
});
