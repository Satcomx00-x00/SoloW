/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AcpScript, writeFakeAcpBin } from "@gatecontrol/acp/testing";
import { createLocalExecutor } from "../executor/local.js";
import { AcpRunner, toStreamEvent } from "./acp-runner.js";
import type { AgentHandle, AgentStreamEvent } from "./runner.js";

/**
 * The ACP client driving a real child process through the real `Executor` (issue #58) — a
 * scripted peer, never a live agent (Principle VI). `packages/acp` proves the protocol; what
 * this file proves is the contract the lifecycle depends on: the run streams, it reports the
 * worktree it was given, operator input reaches it, stopping is not a failure, a quota message
 * parks, and only the credential the billing guard shaped reaches the process.
 */

let handle: AgentHandle | undefined;
let workdir: string | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = undefined;
});

async function run(
  script: AcpScript = {},
  env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "",
    CLAUDE_CODE_OAUTH_TOKEN: "the-credential",
  },
) {
  workdir = await mkdtemp(join(tmpdir(), "gatecontrol-acp-"));
  const events: AgentStreamEvent[] = [];
  const command = await writeFakeAcpBin(workdir, script);
  handle = new AcpRunner({
    executor: createLocalExecutor(workdir),
    permissionDeadlineMs: 2_000,
  }).start({
    command,
    args: [],
    cwd: workdir,
    env,
    // The lifecycle provisions the worktree for an ACP agent and passes none for it to create.
    worktreeName: null,
    prompt: "fix the latch",
    onEvent: (e) => events.push(e),
  });
  return { handle, events, workdir };
}

const stdout = (events: AgentStreamEvent[]) =>
  events.flatMap((e) => (e.kind === "stdout" ? [e.text] : []));

describe("AcpRunner", () => {
  it("streams the agent's output and tool calls, then completes", async () => {
    const { handle: h, events } = await run({
      turns: [{ toolCalls: ["Edit src/latch.ts"], text: ["patched latch.ts"] }],
    });

    expect(await h.outcome).toEqual({ kind: "completed" });
    expect(events.filter((e) => e.kind !== "usage")).toEqual([
      { kind: "tool_use", name: "Edit src/latch.ts" },
      { kind: "stdout", text: "patched latch.ts" },
    ]);
  });

  it("reports the worktree it was pointed at, since ACP agents do not make their own", async () => {
    const { handle: h, workdir: dir } = await run();
    expect(await h.workspacePath).toBe(dir as string);
  });

  it("delivers operator input as the next turn", async () => {
    const { handle: h, events } = await run({
      turns: [{ text: ["first pass"] }, { text: ["added the test"] }],
    });

    expect(await h.send("also add a regression test")).toBe(true);
    expect(await h.outcome).toEqual({ kind: "completed" });
    expect(stdout(events)).toContain("added the test");
  });

  it("refuses input once the run has finished rather than swallowing it", async () => {
    const { handle: h } = await run({ turns: [{ text: ["done"] }] });
    await h.outcome;
    expect(await h.send("too late")).toBe(false);
  });

  it("stopping ends the run without failing it, so partial work still reaches review", async () => {
    const { handle: h, events } = await run({ turns: [{ text: ["working"], hang: true }] });
    for (let i = 0; i < 500 && !stdout(events).includes("working"); i++) {
      await new Promise((r) => setTimeout(r, 2));
    }

    await h.stop();
    // Principle I: whether the partial work is worth keeping is the reviewer's call.
    expect((await h.outcome).kind).toBe("completed");
  });

  it("classifies a quota message on stderr as a park, not a hard failure", async () => {
    // Parking is recoverable and Failed is not, so the distinction decides whether a Task comes
    // back by itself when the window resets (spec AC-013) — for an ACP agent as much as a CLI.
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
    workdir = await mkdtemp(join(tmpdir(), "gatecontrol-acp-"));
    handle = new AcpRunner({ executor: createLocalExecutor(workdir) }).start({
      command: join(workdir, "no-such-agent"),
      args: [],
      cwd: workdir,
      env: { PATH: process.env["PATH"] ?? "" },
      worktreeName: null,
      prompt: "go",
      onEvent: () => {},
    });

    expect((await handle.outcome).kind).toBe("failed");
    // The worktree still exists and is still the Task's, so it is still reported: blaming the
    // isolation for a missing binary would send the lifecycle after the wrong problem.
    expect(await handle.workspacePath).toBe(workdir);
  });
});

describe("AcpRunner permissions (AC-4)", () => {
  const options = [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Reject", kind: "reject_once" },
  ];

  it("surfaces the request, waits for the operator, and sends their choice back", async () => {
    const { handle: h, events } = await run({
      turns: [{ permission: { title: "Write .env", options }, text: ["wrote it"] }],
    });

    // The request is published *before* anyone answers — that is the whole of AC-4.
    let request: Extract<AgentStreamEvent, { kind: "permission_request" }> | undefined;
    for (let i = 0; i < 500 && !request; i++) {
      request = events.find((e) => e.kind === "permission_request");
      if (!request) await new Promise((r) => setTimeout(r, 2));
    }
    expect(request?.title).toBe("Write .env");
    expect(request?.options).toEqual(options);
    // Never the tool call's raw input, which can carry a credential being written to a file.
    expect(JSON.stringify(request)).not.toContain("never-leaves-the-agent");

    expect(await h.respondPermission?.(request?.requestId ?? "", "allow")).toBe("answered");
    expect(await h.outcome).toEqual({ kind: "completed" });

    expect(events.find((e) => e.kind === "permission_resolved")).toEqual({
      kind: "permission_resolved",
      requestId: request?.requestId ?? "",
      optionId: "allow",
      decidedBy: "operator",
    });
    expect(stdout(events)).toContain("wrote it");
  });

  it("refuses when nobody answers, rather than granting what nobody was asked about", async () => {
    // A run nobody is watching must not hang a durable step for days — and must not help itself
    // to the permission either (AC-4). The refusal is what the agent gets from an operator who
    // says no, so the turn ends rather than proceeding without consent.
    const { handle: h, events } = await run({
      turns: [{ permission: { title: "Write .env", options }, text: ["wrote it"] }],
    });

    // The agent treats a declined permission as a refusal and gives up on the turn, which is a
    // failed run rather than an empty one sent to review — the trade AC-4 asks for.
    expect((await h.outcome).kind).toBe("failed");
    expect(events.find((e) => e.kind === "permission_resolved")).toMatchObject({
      optionId: null,
      decidedBy: "policy",
    });
    // Legible in the terminal, and therefore in the session log the reviewer reads afterwards.
    expect(stdout(events).join("")).toContain("permission refused by policy");
    expect(stdout(events).join("")).not.toContain("wrote it");
  });

  it("grants on the deadline only for a deployment that configured that posture", async () => {
    workdir = await mkdtemp(join(tmpdir(), "gatecontrol-acp-"));
    const events: AgentStreamEvent[] = [];
    const command = await writeFakeAcpBin(workdir, {
      turns: [{ permission: { title: "Write .env", options }, text: ["wrote it"] }],
    });
    handle = new AcpRunner({
      executor: createLocalExecutor(workdir),
      permissionDeadlineMs: 2_000,
      unattendedPermissionPosture: "allow_once",
    }).start({
      command,
      args: [],
      cwd: workdir,
      env: { PATH: process.env["PATH"] ?? "" },
      worktreeName: null,
      prompt: "fix the latch",
      onEvent: (e) => events.push(e),
    });

    expect(await handle.outcome).toEqual({ kind: "completed" });
    expect(events.find((e) => e.kind === "permission_resolved")).toMatchObject({
      optionId: "allow",
      decidedBy: "policy",
    });
  });

  it("reports that an answer for an unknown request reached nothing", async () => {
    const { handle: h } = await run({ turns: [{ text: ["no questions asked"] }] });
    await h.outcome;
    expect(await h.respondPermission?.("req-nonexistent", "allow")).toBe("not_pending");
  });
});

describe("AcpRunner credential isolation (AC-5 / Principle IV)", () => {
  it("hands the agent process only the credential the billing guard shaped", async () => {
    // The fake writes the *names* of its environment variables — never the values — into the
    // worktree, which is the only way to see what a spawned child actually received.
    process.env["GATECONTROL_ACP_TEST_MARKER"] ??= "present-in-the-orchestrator";
    const { handle: h, workdir: dir } = await run({
      writeEnvNames: "env-names.json",
      turns: [{ text: ["ok"] }],
    });
    await h.outcome;

    const names: string[] = JSON.parse(
      await readFile(join(dir as string, "env-names.json"), "utf8"),
    );
    expect(names).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    // The metered variable the guard strips must not be there…
    expect(names).not.toContain("ANTHROPIC_API_KEY");
    // …and neither must anything of the orchestrator's own environment, which proves the child
    // environment was *replaced* rather than merged.
    expect(names).not.toContain("GATECONTROL_ACP_TEST_MARKER");
  });
});

describe("toStreamEvent", () => {
  it("marks the agent's thinking so the terminal matches the recorded transcript", () => {
    expect(toStreamEvent({ kind: "text", channel: "thinking", text: "considering" })).toEqual({
      kind: "stdout",
      text: "· considering",
    });
  });

  it("keeps the session preamble out of the terminal", () => {
    expect(toStreamEvent({ kind: "session", sessionId: "s1", cwd: "/wt/x" })).toBeNull();
  });

  it("says nothing about an ordinary end of turn, and names an unusual one", () => {
    expect(
      toStreamEvent({ kind: "result", ok: true, stopReason: "end_turn", error: null }),
    ).toBeNull();
    expect(
      toStreamEvent({ kind: "result", ok: false, stopReason: "refusal", error: null }),
    ).toEqual({ kind: "stdout", text: "\n[refusal]\n" });
  });
});
