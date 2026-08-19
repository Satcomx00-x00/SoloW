/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_AGENT_MAIN, type FakeAgentScript } from "@gatecontrol/acp/testing";
import { AcpAgentRunner, toStreamEvent } from "./acp-runner.js";
import type { AgentHandle, AgentStreamEvent } from "./runner.js";

/**
 * The real runner against a real (scripted) agent process (task TASK-014). What matters here is
 * the contract the lifecycle and the terminal depend on: events arrive in order, operator input
 * becomes a further turn, stopping ends the run without failing it, and a run that dies with a
 * quota message parks rather than fails.
 */

let handle: AgentHandle | undefined;
let workdir: string | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = undefined;
});

async function run(script: FakeAgentScript, prompt = "fix the latch") {
  workdir = await mkdtemp(join(tmpdir(), "gatecontrol-runner-"));
  const events: AgentStreamEvent[] = [];
  handle = new AcpAgentRunner().start({
    command: process.execPath,
    args: ["run", FAKE_AGENT_MAIN, JSON.stringify(script)],
    cwd: workdir,
    env: { PATH: process.env["PATH"] ?? "", CLAUDE_CODE_OAUTH_TOKEN: "the-credential" },
    prompt,
    onEvent: (e) => events.push(e),
  });
  return { handle, events, workdir };
}

describe("AcpAgentRunner", () => {
  it("streams the agent's output and tool calls, then completes", async () => {
    const { handle: h, events } = await run({
      turns: [{ toolCalls: ["edit"], chunks: ["patched ", "latch.ts"] }],
    });

    expect(await h.outcome).toEqual({ kind: "completed" });
    expect(events).toEqual([
      { kind: "tool_use", name: "edit (completed)" },
      { kind: "stdout", text: "patched " },
      { kind: "stdout", text: "latch.ts" },
    ]);
  });

  it("delivers operator input as a further turn before the run ends", async () => {
    const { handle: h, events } = await run({
      turns: [{ chunks: ["first pass done"] }, { chunks: ["added the test"] }],
    });

    // The terminal sends while the first turn is still in flight — the run must not finish
    // until that input has been given to the agent (TASK-022).
    expect(await h.send("also add a regression test")).toBe(true);
    expect(await h.outcome).toEqual({ kind: "completed" });
    expect(events.map((e) => (e.kind === "stdout" ? e.text : e.name))).toEqual([
      "first pass done",
      "added the test",
    ]);
  });

  it("refuses input once the run has finished rather than swallowing it", async () => {
    const { handle: h } = await run({ turns: [{ chunks: ["done"] }] });
    await h.outcome;
    expect(await h.send("too late")).toBe(false);
  });

  it("stopping ends the run without failing it, so partial work still reaches review", async () => {
    const { handle: h } = await run({ turns: [{ chunks: ["working"] }] });
    await h.stop();
    // Principle I: whether the partial work is worth keeping is the reviewer's call, not ours.
    expect((await h.outcome).kind).toBe("completed");
  });

  it("reports the agent's own permission decision on the stream", async () => {
    const { handle: h, events } = await run({ turns: [{ requestPermission: true }] });
    await h.outcome;
    expect(events).toContainEqual({ kind: "tool_use", name: "Edit files — permitted" });
  });

  it("classifies a quota message on stderr as a park, not a hard failure", async () => {
    workdir = await mkdtemp(join(tmpdir(), "gatecontrol-runner-"));
    const events: AgentStreamEvent[] = [];
    // An agent that prints a quota error and exits before speaking ACP at all — the shape of a
    // real quota exhaustion, and the case that decides Parked vs Failed (spec AC-013).
    handle = new AcpAgentRunner().start({
      command: "/bin/sh",
      args: ["-c", "echo 'API error: usage limit reached' >&2; exit 1"],
      cwd: workdir,
      env: { PATH: process.env["PATH"] ?? "" },
      prompt: "fix the latch",
      onEvent: (e) => events.push(e),
    });

    expect(await handle.outcome).toEqual({
      kind: "failed",
      signal: { quotaExhausted: true },
    });
  });

  it("classifies an unrecognised crash as a plain failure", async () => {
    workdir = await mkdtemp(join(tmpdir(), "gatecontrol-runner-"));
    handle = new AcpAgentRunner().start({
      command: "/bin/sh",
      args: ["-c", "echo 'Segmentation fault' >&2; exit 139"],
      cwd: workdir,
      env: { PATH: process.env["PATH"] ?? "" },
      prompt: "fix the latch",
      onEvent: () => {},
    });

    const outcome = await handle.outcome;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.signal).toEqual({});
  });
});

describe("toStreamEvent", () => {
  it("marks agent thoughts so the terminal matches the recorded transcript", () => {
    expect(toStreamEvent({ kind: "text", channel: "thought", text: "considering" })).toEqual({
      kind: "stdout",
      text: "· considering",
    });
    expect(toStreamEvent({ kind: "text", channel: "agent", text: "done" })).toEqual({
      kind: "stdout",
      text: "done",
    });
  });

  it("names a tool call with its status", () => {
    expect(
      toStreamEvent({ kind: "tool_call", toolCallId: "t1", title: "read", status: "pending" }),
    ).toEqual({ kind: "tool_use", name: "read (pending)" });
  });
});
