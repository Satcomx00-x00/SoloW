/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FakeClaudeScript, writeFakeClaudeBin } from "@gatecontrol/claude-code/testing";
import { createLocalExecutor } from "../executor/local.js";
import { ClaudeCodeRunner, toStreamEvent, worktreeNameForTask } from "./claude-code-runner.js";
import type { AgentHandle, AgentStreamEvent } from "./runner.js";

/**
 * Claude Code driven as GateControl's agent (task TASK-014), against a real child process
 * speaking the real stream-JSON protocol. What matters here is the contract the lifecycle
 * depends on: the run streams, it reports which worktree it is in, operator input reaches it,
 * stopping is not a failure, and a quota message parks rather than fails.
 */

let handle: AgentHandle | undefined;
let workdir: string | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = undefined;
});

async function run(script: FakeClaudeScript = {}, prompt = "fix the latch") {
  workdir = await mkdtemp(join(tmpdir(), "gatecontrol-cc-"));
  const events: AgentStreamEvent[] = [];
  const command = await writeFakeClaudeBin(workdir, { cwd: workdir, ...script });
  handle = new ClaudeCodeRunner({ executor: createLocalExecutor(workdir) }).start({
    command,
    args: [],
    cwd: workdir,
    env: { PATH: process.env["PATH"] ?? "", CLAUDE_CODE_OAUTH_TOKEN: "the-credential" },
    worktreeName: worktreeNameForTask("task-1"),
    prompt,
    onEvent: (e) => events.push(e),
  });
  return { handle, events, workdir };
}

describe("worktreeNameForTask", () => {
  it("names the worktree after the Task, so a stray directory is traceable", () => {
    expect(worktreeNameForTask("abc")).toBe("gatecontrol-task-abc");
    expect(worktreeNameForTask("a")).not.toBe(worktreeNameForTask("b"));
  });
});

describe("ClaudeCodeRunner", () => {
  it("streams the agent's output and tool calls, then completes", async () => {
    const { handle: h, events } = await run({
      turns: [{ tools: ["Edit"], text: ["patched latch.ts"] }],
    });

    expect(await h.outcome).toEqual({ kind: "completed" });
    // Usage rides alongside each block and is asserted separately, below.
    expect(events.filter((e) => e.kind !== "usage")).toEqual([
      { kind: "tool_use", name: "Edit" },
      { kind: "stdout", channel: "assistant", text: "patched latch.ts" },
      { kind: "stdout", channel: "system", text: "\ndone\n" },
    ]);
  });

  it("reports the worktree Claude Code created, so the lifecycle can adopt it", async () => {
    // This is the whole point of `--worktree`: GateControl no longer picks the directory, it
    // finds out which one the agent made.
    const { handle: h, workdir: dir } = await run();
    expect(await h.workspacePath).toBe(dir as string);
  });

  it("delivers operator input into the live session", async () => {
    const { handle: h, events } = await run({
      turns: [{ text: ["first pass"] }, { text: ["added the test"] }],
    });

    expect(await h.send("also add a regression test")).toBe(true);
    expect(await h.outcome).toEqual({ kind: "completed" });
    expect(events.flatMap((e) => (e.kind === "stdout" ? [e.text] : []))).toContain(
      "added the test",
    );
  });

  it("refuses input once the run has finished rather than swallowing it", async () => {
    const { handle: h } = await run({ turns: [{ text: ["done"] }] });
    await h.outcome;
    expect(await h.send("too late")).toBe(false);
  });

  it("stopping ends the run without failing it, so partial work still reaches review", async () => {
    const { handle: h } = await run({ turns: [{ text: ["working"] }, { text: ["more"] }] });
    await h.stop();
    // Principle I: whether the partial work is worth keeping is the reviewer's call.
    expect((await h.outcome).kind).toBe("completed");
  });

  it("fails the run when the CLI reports an error result", async () => {
    const { handle: h } = await run({
      turns: [{ text: ["gave up"] }],
      failWith: "error_during_execution",
    });
    expect((await h.outcome).kind).toBe("failed");
  });

  it("classifies a quota message on stderr as a park, not a hard failure", async () => {
    // Parking is recoverable and Failed is not, so the distinction decides whether a Task comes
    // back by itself when the window resets (spec AC-013).
    const { handle: h } = await run({
      dieEarly: true,
      stderr: "API error: usage limit reached, resets at 18:00\n",
    });
    expect(await h.outcome).toEqual({ kind: "failed", signal: { quotaExhausted: true } });
  });

  it("classifies an unrecognised crash as a plain failure", async () => {
    const { handle: h } = await run({ dieEarly: true, stderr: "Segmentation fault\n" });
    const outcome = await h.outcome;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.signal).toEqual({});
  });

  it("fails rather than hangs when the binary does not exist", async () => {
    workdir = await mkdtemp(join(tmpdir(), "gatecontrol-cc-"));
    handle = new ClaudeCodeRunner({ executor: createLocalExecutor(workdir) }).start({
      command: join(workdir, "no-such-claude"),
      args: [],
      cwd: workdir,
      env: { PATH: process.env["PATH"] ?? "" },
      worktreeName: "gatecontrol-task-x",
      prompt: "go",
      onEvent: () => {},
    });

    expect((await handle.outcome).kind).toBe("failed");
    // And it reports no workspace, which the lifecycle treats as a failure to isolate.
    expect(await handle.workspacePath).toBeNull();
  });
});

describe("toStreamEvent", () => {
  it("carries the channel a line came in on rather than baking it into the text", () => {
    // The "· " thinking marker is presentation and is re-applied by the wire projection
    // (`toTaskEvent`); what the runner reports is *whose* line this was (issue #2).
    expect(toStreamEvent({ kind: "text", channel: "thinking", text: "considering" })).toEqual({
      kind: "stdout",
      channel: "thinking",
      text: "considering",
    });
  });

  it("keeps the session preamble out of the terminal", () => {
    // It is plumbing: the worktree it carries is read by the lifecycle, not shown to a reviewer.
    expect(toStreamEvent({ kind: "session", cwd: "/wt/x", sessionId: "s" })).toBeNull();
  });

  it("says nothing for a result that carried no closing text", () => {
    expect(toStreamEvent({ kind: "result", ok: true, subtype: "success", text: null })).toBeNull();
  });
});

describe("usage reaches the orchestrator once per turn (issue #14)", () => {
  it("reports one usage event per turn, not one per content block", async () => {
    // Two content blocks in a single turn: a tool call and a line of text. The CLI repeats the
    // turn's usage on both; the consumer must be able to tell they are the same turn.
    const { handle: h, events } = await run({
      turns: [{ tools: ["edit_file"], text: ["applied the change"] }],
    });
    await h.outcome;

    const usage = events.flatMap((e) => (e.kind === "usage" ? [e] : []));
    expect(usage.length).toBeGreaterThan(1);
    expect(new Set(usage.map((u) => u.messageId)).size).toBe(1);
    // Every repeat carries identical counts — which is exactly why summing them is wrong.
    expect(new Set(usage.map((u) => u.inputTokens)).size).toBe(1);
    expect(usage[0]?.reported).toBe(true);
    expect(usage[0]?.model).toBe("test-model");
  });

  it("distinguishes turns, so a steered run records both", async () => {
    const { handle: h, events } = await run({
      turns: [{ text: ["first"] }, { text: ["second"] }],
    });
    await h.send("keep going");
    await h.outcome;

    const ids = new Set(
      events.flatMap((e) => (e.kind === "usage" && e.messageId ? [e.messageId] : [])),
    );
    expect(ids.size).toBe(2);
  });
});
