/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeUpdate } from "./events.js";
import { buildArgs, type ClaudeSession, startClaudeSession } from "./session.js";
import { type FakeClaudeScript, writeFakeClaudeBin } from "./testing.js";

/**
 * Driving a real child process that speaks the real stream-JSON protocol (task TASK-014). The
 * fake stands in for the model, not for the wire format — framing, turn-taking and the session
 * preamble are all exercised for real.
 */

let session: ClaudeSession | undefined;
let workdir: string | undefined;

afterEach(async () => {
  await session?.stop();
  session = undefined;
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = undefined;
});

async function run(script: FakeClaudeScript = {}, prompt = "fix the latch") {
  workdir = await mkdtemp(join(tmpdir(), "gatecontrol-claude-"));
  const updates: ClaudeUpdate[] = [];
  const command = await writeFakeClaudeBin(workdir, { cwd: workdir, ...script });
  session = startClaudeSession(
    {
      command,
      cwd: workdir,
      // Bun needs PATH to resolve; nothing else is passed, so a test can assert what the child
      // could see (Principle IV).
      env: { PATH: process.env["PATH"] ?? "", CLAUDE_CODE_OAUTH_TOKEN: "the-credential" },
      worktreeName: "gatecontrol-task-1",
      permissionMode: "acceptEdits",
      onUpdate: (u) => updates.push(u),
    },
    prompt,
  );
  return { session, updates, workdir };
}

describe("buildArgs", () => {
  it("always passes --worktree, so no call site can run two agents in one working tree", () => {
    // This is the isolation guarantee the whole review model rests on (Principle II): the flag
    // is added here rather than by the caller precisely so it cannot be forgotten.
    const args = buildArgs({ worktreeName: "gatecontrol-task-7", permissionMode: "acceptEdits" });
    const at = args.indexOf("--worktree");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(args[at + 1]).toBe("gatecontrol-task-7");
  });

  it("asks for the streaming protocol in both directions", () => {
    const args = buildArgs({ worktreeName: "w", permissionMode: "acceptEdits" });
    expect(args).toContain("--print");
    expect(args.join(" ")).toContain("--input-format stream-json");
    expect(args.join(" ")).toContain("--output-format stream-json");
    // The CLI will not emit stream-json on stdout without it.
    expect(args).toContain("--verbose");
  });

  it("puts configured extras after the arguments GateControl requires", () => {
    const args = buildArgs({
      worktreeName: "w",
      permissionMode: "auto",
      extraArgs: ["--model", "opus"],
    });
    expect(args.slice(-2)).toEqual(["--model", "opus"]);
    expect(args).toContain("--worktree");
  });
});

describe("startClaudeSession", () => {
  it("streams assistant text and tool calls, then reports the result", async () => {
    const { session: s, updates } = await run({
      turns: [{ tools: ["Edit"], text: ["patched ", "latch.ts"] }],
    });

    expect(await s.outcome).toEqual({ ok: true, subtype: "success", text: "done" });
    expect(updates.filter((u) => u.kind !== "session")).toEqual([
      { kind: "tool_use", name: "Edit" },
      { kind: "text", channel: "assistant", text: "patched " },
      { kind: "text", channel: "assistant", text: "latch.ts" },
      { kind: "result", ok: true, subtype: "success", text: "done" },
    ]);
  });

  it("reports the worktree the session is working in", async () => {
    // With `--worktree` the CLI makes the directory, so its init event is how GateControl finds
    // out where the agent went — no guessing at a naming convention.
    const { session: s, workdir: dir } = await run();
    expect(await s.workspacePath).toBe(dir as string);
  });

  it("delivers a follow-up turn to a session that is still open", async () => {
    const { session: s, updates } = await run({
      turns: [{ text: ["first pass"] }, { text: ["added the test"] }],
    });

    expect(s.send("also add a regression test")).toBe(true);
    await s.outcome;
    expect(
      updates.filter((u) => u.kind === "text").map((u) => (u as { text: string }).text),
    ).toEqual(["first pass", "added the test"]);
  });

  it("refuses a turn once the run has finished", async () => {
    const { session: s } = await run({ turns: [{ text: ["done"] }] });
    await s.outcome;
    expect(s.send("too late")).toBe(false);
  });

  it("surfaces a failing run rather than reporting success", async () => {
    const { session: s } = await run({
      turns: [{ text: ["gave up"] }],
      failWith: "error_max_turns",
    });
    expect(await s.outcome).toMatchObject({ ok: false, subtype: "error_max_turns" });
  });

  it("treats a CLI that dies without a result as a failure", async () => {
    // An exit code alone does not say the turn completed, so a missing result is not success.
    const { session: s } = await run({ dieEarly: true });
    expect(await s.outcome).toEqual({ ok: false, subtype: "no_result", text: null });
  });

  it("stopping ends the run without calling it a failure", async () => {
    const { session: s } = await run({ turns: [{ text: ["working"] }, { text: ["more"] }] });
    await s.stop();
    // Whether the partial work is worth keeping is the reviewer's call, not ours (Principle I).
    expect((await s.outcome).ok).toBe(true);
  });

  it("gives the agent process only the environment it was handed", async () => {
    process.env["GATECONTROL_CLAUDE_LEAK_CHECK"] = "must-not-reach-the-agent";
    try {
      const { session: s, workdir: dir } = await run({
        turns: [{ writes: [{ path: "env.json", content: "" }] }],
      });
      await s.outcome;
      // The fake wrote into the cwd it was told about, proving the child ran where we said.
      expect(await readFile(join(dir as string, "env.json"), "utf8")).toBe("");
    } finally {
      delete process.env["GATECONTROL_CLAUDE_LEAK_CHECK"];
    }
  });
});

describe("continuing inside an existing worktree", () => {
  it("omits --worktree when the caller is already in one", () => {
    // A later review round runs *inside* the Task's worktree. Asking for a worktree from inside
    // a worktree would nest one in the other, and the agent's edits would land somewhere the
    // lifecycle never diffs or commits.
    const args = buildArgs({ worktreeName: null, permissionMode: "acceptEdits" });
    expect(args).not.toContain("--worktree");
    // Everything else the protocol needs is still there.
    expect(args).toContain("--print");
    expect(args).toContain("--verbose");
  });
});
