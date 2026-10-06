/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AcpScript, writeFakeAcpBin } from "@solow/acp/testing";
import { createLocalExecutor } from "../executor/local.js";
import { AcpRunner, type AcpRunnerOptions, refusalVerdict, toStreamEvent } from "./acp-runner.js";
import { harnessConfigEnv } from "./hermetic-home.js";
import type { HarnessHandle, HarnessStartOpts, HarnessStreamEvent } from "./runner.js";

/**
 * The ACP client driving a real child process through the real `Executor` (issue #58) — a
 * scripted peer, never a live harness (Principle VI). `packages/acp` proves the protocol; what
 * this file proves is the contract the lifecycle depends on: the run streams, it reports the
 * worktree it was given, operator input reaches it, stopping is not a failure, a quota message
 * parks, and only the credential the billing guard shaped reaches the process.
 */

let handle: HarnessHandle | undefined;
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
  /** Per-round facts a test wants to vary — a conversation to carry on, so far. */
  over: Partial<HarnessStartOpts> = {},
  /** The Profile's side of the run — a pinned model or mode. */
  runnerOver: Partial<AcpRunnerOptions> = {},
) {
  workdir = await mkdtemp(join(tmpdir(), "solow-acp-"));
  const events: HarnessStreamEvent[] = [];
  const command = await writeFakeAcpBin(workdir, script);
  handle = new AcpRunner({
    executor: createLocalExecutor(workdir),
    permissionDeadlineMs: 2_000,
    ...runnerOver,
  }).start({
    command,
    args: [],
    cwd: workdir,
    env,
    // The lifecycle provisions the worktree for an ACP agent and passes none for it to create.
    worktreeName: null,
    prompt: "fix the latch",
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { handle, events, workdir };
}

const stdout = (events: HarnessStreamEvent[]) =>
  events.flatMap((e) => (e.kind === "stdout" ? [e.text] : []));

describe("AcpRunner", () => {
  it("streams the harness's output and tool calls, then completes", async () => {
    const { handle: h, events } = await run({
      turns: [{ toolCalls: ["Edit src/latch.ts"], text: ["patched latch.ts"] }],
    });

    expect(await h.outcome).toEqual({ kind: "completed", stopReason: "end_turn" });
    expect(events.filter((e) => e.kind !== "usage")).toEqual([
      // ACP carried the id and the status all along; this seam used to drop both, so a
      // `tool_call_update` arrived looking like a second, unrelated call.
      {
        kind: "tool_use",
        name: "Edit src/latch.ts",
        callId: "call-Edit src/latch.ts",
        input: undefined,
        status: "in_progress",
      },
      { kind: "stdout", channel: "assistant", text: "patched latch.ts" },
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
    expect(await h.outcome).toEqual({ kind: "completed", stopReason: "end_turn" });
    expect(stdout(events)).toContain("added the test");
  });

  it("echoes accepted operator input onto the stream, since the harness's own output never does", async () => {
    // Same reasoning as `ClaudeCodeRunner`'s equivalent test: with no echo, `task-run.ts` has no
    // `channel: "user"` update to turn into the `user_turn` session_event the transcript needs
    // both to show the message was sent and to stop it merging into the surrounding harness text.
    const { handle: h, events } = await run({
      turns: [{ text: ["first pass"] }, { text: ["added the test"] }],
    });

    await h.send("also add a regression test");
    await h.outcome;

    expect(events).toContainEqual({
      kind: "stdout",
      channel: "user",
      text: "also add a regression test",
    });
  });

  it("refuses input once the run has finished rather than swallowing it", async () => {
    const { handle: h } = await run({ turns: [{ text: ["done"] }] });
    await h.outcome;
    expect(await h.send("too late")).toBe(false);
  });

  it("does not echo input the run refused to accept", async () => {
    const { handle: h, events } = await run({ turns: [{ text: ["done"] }] });
    await h.outcome;

    await h.send("too late");

    expect(events).not.toContainEqual(expect.objectContaining({ kind: "stdout", channel: "user" }));
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
    expect(await h.outcome).toEqual({
      kind: "failed",
      signal: { quotaExhausted: true },
      stopReason: "no_result",
    });
  });

  it("classifies an unrecognised crash as a plain failure", async () => {
    const { handle: h } = await run({ dieEarly: true, stderr: "Segmentation fault\n" });
    const outcome = await h.outcome;
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    // Plain by class — neither a quota nor a credential — and said in words rather than as "fail".
    expect(outcome.signal.quotaExhausted).toBeUndefined();
    expect(outcome.signal.credentialInvalid).toBeUndefined();
    expect(outcome.signal.verdict).toBe(
      "The harness ended the session: the agent closed its output stream",
    );
  });

  it("fails a harness below the catalog's pin, carrying the refusal as the run's verdict", async () => {
    workdir = await mkdtemp(join(tmpdir(), "solow-acp-"));
    const command = await writeFakeAcpBin(workdir, {
      agentInfo: { name: "OpenCode", version: "1.17.2" },
    });
    handle = new AcpRunner({
      executor: createLocalExecutor(workdir),
      minVersion: "1.18.33",
      harnessName: "opencode",
      installHint: "npm install -g opencode-ai@latest",
    }).start({
      command,
      args: [],
      cwd: workdir,
      env: { PATH: process.env["PATH"] ?? "" },
      worktreeName: null,
      prompt: "go",
      onEvent: () => {},
    });

    const outcome = await handle.outcome;
    expect(outcome.kind).toBe("failed");
    // A hard failure by class — nothing to park or renew — with words the operator can act on.
    if (outcome.kind === "failed") {
      expect(outcome.signal).toEqual({
        verdict:
          "opencode 1.17.2 is older than 1.18.33, the oldest version this build supports — upgrade it (npm install -g opencode-ai@latest)",
      });
    }
    expect(await handle.harnessSessionId).toBeNull();
  });

  it("fails rather than hangs when the binary does not exist", async () => {
    workdir = await mkdtemp(join(tmpdir(), "solow-acp-"));
    handle = new AcpRunner({ executor: createLocalExecutor(workdir) }).start({
      command: join(workdir, "no-such-harness"),
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
    let request: Extract<HarnessStreamEvent, { kind: "permission_request" }> | undefined;
    for (let i = 0; i < 500 && !request; i++) {
      request = events.find((e) => e.kind === "permission_request");
      if (!request) await new Promise((r) => setTimeout(r, 2));
    }
    expect(request?.title).toBe("Write .env");
    expect(request?.options).toEqual(options);
    // Never the tool call's raw input, which can carry a credential being written to a file.
    expect(JSON.stringify(request)).not.toContain("never-leaves-the-harness");

    expect(await h.respondPermission?.(request?.requestId ?? "", "allow")).toBe("answered");
    expect(await h.outcome).toEqual({ kind: "completed", stopReason: "end_turn" });

    expect(events.find((e) => e.kind === "permission_resolved")).toEqual({
      kind: "permission_resolved",
      requestId: request?.requestId ?? "",
      optionId: "allow",
      decidedBy: "operator",
    });
    expect(stdout(events)).toContain("wrote it");
  });

  it("does not offer an option the harness gave no id, because nobody could choose it", async () => {
    // The ACP wire schema asks only for a string, so a harness may offer an option with an empty
    // id. Answering names the option by id, and an empty one resolves to a cancellation whatever
    // was clicked — and the session log's contract will not admit it either, which used to mean
    // the whole request reached the operator live and never reached the log at all.
    const { handle: h, events } = await run({
      turns: [
        {
          permission: {
            title: "Write .env",
            options: [
              { optionId: "", name: "Allow", kind: "allow_once" },
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
            ],
          },
          text: ["wrote it"],
        },
      ],
    });

    let request: Extract<HarnessStreamEvent, { kind: "permission_request" }> | undefined;
    for (let i = 0; i < 500 && !request; i++) {
      request = events.find((e) => e.kind === "permission_request");
      if (!request) await new Promise((r) => setTimeout(r, 2));
    }
    expect(request?.options).toEqual([
      { optionId: "allow", name: "Allow once", kind: "allow_once" },
    ]);

    expect(await h.respondPermission?.(request?.requestId ?? "", "allow")).toBe("answered");
    expect(await h.outcome).toEqual({ kind: "completed", stopReason: "end_turn" });
  });

  it("refuses when nobody answers, rather than granting what nobody was asked about", async () => {
    // A run nobody is watching must not hang a durable step for days — and must not help itself
    // to the permission either (AC-4). The refusal is what the harness gets from an operator who
    // says no, so the turn ends rather than proceeding without consent.
    const { handle: h, events } = await run({
      turns: [{ permission: { title: "Write .env", options }, text: ["wrote it"] }],
    });

    // The harness treats a declined permission as a refusal and gives up on the turn, which is a
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
    workdir = await mkdtemp(join(tmpdir(), "solow-acp-"));
    const events: HarnessStreamEvent[] = [];
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

    expect(await handle.outcome).toEqual({ kind: "completed", stopReason: "end_turn" });
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
  it("hands the harness process only the credential the billing guard shaped", async () => {
    // The fake writes the *names* of its environment variables — never the values — into the
    // worktree, which is the only way to see what a spawned child actually received.
    process.env["SOLOW_ACP_TEST_MARKER"] ??= "present-in-the-orchestrator";
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
    expect(names).not.toContain("SOLOW_ACP_TEST_MARKER");
  });
});

describe("AcpRunner configuration isolation (Decision 0027)", () => {
  it("hands the harness the home the app shaped, not the operator's", async () => {
    // `$HOME` is a path, not a credential, so this one can assert the value: what it proves is
    // that the harness looks for `~/.claude`, `~/.claude.json` and `$HOME/CLAUDE.md` inside a
    // directory SoloW owns. Same mechanism as the credential test above — the environment the
    // runner spawns with is the only thing between the agent and the operator's own config.
    const appHome = await mkdtemp(join(tmpdir(), "solow-acp-home-"));
    try {
      const { handle: h, workdir: dir } = await run(
        { writeEnvHome: "env-home.txt" },
        {
          PATH: process.env["PATH"] ?? "",
          CLAUDE_CODE_OAUTH_TOKEN: "the-credential",
          ...harnessConfigEnv(appHome),
        },
      );
      await h.outcome;

      const home = await readFile(join(dir as string, "env-home.txt"), "utf8");
      expect(home).toBe(appHome);
      expect(home).not.toBe(process.env["HOME"]);
    } finally {
      await rm(appHome, { recursive: true, force: true });
    }
  });
});

describe("toStreamEvent", () => {
  it("carries the channel a line came in on rather than baking it into the text", () => {
    // The "· " thinking marker is presentation and is re-applied by the wire projection
    // (`toTaskEvent`); what the runner reports is *whose* line this was, which is the thing the
    // session log could not previously record (issue #2).
    expect(toStreamEvent({ kind: "text", channel: "thinking", text: "considering" })).toEqual({
      kind: "stdout",
      channel: "thinking",
      text: "considering",
    });
    expect(toStreamEvent({ kind: "text", channel: "user", text: "also add a test" })).toEqual({
      kind: "stdout",
      channel: "user",
      text: "also add a test",
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
    ).toEqual({ kind: "stdout", channel: "system", text: "\n[refusal]\n" });
  });
});

describe("what the run says about how it stopped", () => {
  it("reports the agent's session id, so the run can be loaded again later", async () => {
    const { handle: h } = await run({ turns: [{ text: ["ok"] }] });
    expect(await h.harnessSessionId).toBe("acp-session-1");
    await h.outcome;
  });

  it("carries a token budget as a completed turn that was cut short", async () => {
    // ACP says `max_tokens` on a turn that ended for want of context, and counts it a success.
    // The lifecycle is the party that decides what a truncated success means for the Task.
    const { handle: h } = await run({ turns: [{ text: ["half"], stopReason: "max_tokens" }] });
    expect(await h.outcome).toEqual({ kind: "completed", stopReason: "max_tokens" });
  });

  it("names a refusal as such", async () => {
    const { handle: h } = await run({ turns: [{ text: ["no"], stopReason: "refusal" }] });
    expect(await h.outcome).toEqual({ kind: "failed", signal: {}, stopReason: "refusal" });
  });
});

/**
 * Carrying the conversation across a re-spawn.
 *
 * The lifecycle loses this process every time a durable step is redriven or an execution budget
 * runs out. What it needs from the runner is narrow: use the id when the harness can, do not fail
 * the round when it cannot, and say which of the two happened.
 */
describe("resuming a conversation", () => {
  it("picks up the conversation it was given, and says it did", async () => {
    const { handle: h } = await run({ agentCapabilities: { loadSession: true } }, undefined, {
      resumeSessionId: "old-session",
    });

    expect(await h.outcome).toEqual({ kind: "completed", stopReason: "end_turn" });
    expect(await h.resumed).toBe(true);
    // The loaded id, not a new one — this is the conversation the lifecycle recorded last round.
    expect(await h.harnessSessionId).toBe("old-session");
  });

  it("starts a fresh conversation rather than failing, when the harness cannot load one", async () => {
    /*
     * The runner's own decision, and the reason it does not simply pass the id through: the
     * client hard-fails by default, which would turn "we tried to keep the context" into "the
     * round did not run". A harness with no memory of the work still does the work.
     */
    const { handle: h } = await run({}, undefined, { resumeSessionId: "old-session" });

    expect(await h.outcome).toEqual({ kind: "completed", stopReason: "end_turn" });
    expect(await h.resumed).toBe(false);
    expect(await h.harnessSessionId).toBe("acp-session-1");
  });

  it("reports a round that was never asked to resume as a fresh one", async () => {
    const { handle: h } = await run({ agentCapabilities: { loadSession: true } });
    await h.outcome;
    expect(await h.resumed).toBe(false);
  });
});

describe("AcpRunner — opencode 2's config options", () => {
  /*
   * opencode 2.0.22 lists its models as `configOptions` and has no `session/set_model`. Before the
   * fix, a Profile that pinned a model failed every run with a bare "fail"; verified against the
   * real binary, scripted here.
   */
  const opencode2: AcpScript = {
    noSetModel: true,
    configOptions: [
      {
        id: "model",
        category: "model",
        options: [{ value: "opencode/fledge-alpha-free" }, { value: "opencode/nemotron-free" }],
      },
      { id: "mode", category: "mode", options: [{ value: "build" }, { value: "plan" }] },
    ],
    turns: [{ text: ["wrote hello.txt"] }],
  };

  it("runs on the pinned model, chosen through the config option", async () => {
    const { handle: h, events } = await run(
      opencode2,
      undefined,
      {},
      {
        modelId: "opencode/nemotron-free",
        modeId: "build",
      },
    );

    expect(await h.outcome).toEqual({ kind: "completed", stopReason: "end_turn" });
    expect(stdout(events).join("")).toContain("wrote hello.txt");
  });

  it("fails in the agent's words when it refuses a pin, rather than as a bare failure", async () => {
    // An agent that offers models the spec way but cannot take `session/set_model`.
    const { handle: h } = await run(
      { noSetModel: true, models: { availableModels: [{ modelId: "m-1" }] } },
      undefined,
      {},
      { modelId: "m-1" },
    );
    const outcome = await h.outcome;

    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") return;
    expect(outcome.signal.verdict).toStartWith("The harness ended the session:");
    expect(outcome.signal.verdict).toContain("session/set_model");
  });
});

describe("refusalVerdict", () => {
  it("puts the agent's message in words for a plain failure", () => {
    expect(refusalVerdict("Authentication required: provider authentication required", {})).toBe(
      "The harness ended the session: Authentication required: provider authentication required",
    );
  });

  it("leaves a classified failure its class, which is what the page acts on", () => {
    expect(refusalVerdict("401 unauthorized", { credentialInvalid: true })).toBeUndefined();
    expect(refusalVerdict("usage limit reached", { quotaExhausted: true })).toBeUndefined();
    expect(refusalVerdict("no conversation found", { resumeLost: true })).toBeUndefined();
  });

  it("says nothing when the agent said nothing", () => {
    expect(refusalVerdict(null, {})).toBeUndefined();
    expect(refusalVerdict("   ", {})).toBeUndefined();
  });

  it("keeps a long message to one line and a bounded length", () => {
    const said = refusalVerdict(`first line\n${"x".repeat(1000)}`, {}) ?? "";
    expect(said).not.toContain("\n");
    expect(said.length).toBeLessThanOrEqual("The harness ended the session: ".length + 240);
    expect(said.endsWith("…")).toBe(true);
  });
});
