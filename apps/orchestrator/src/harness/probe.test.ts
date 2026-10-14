/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeAcpBin } from "@solow/acp/testing";
import { writeFakeClaudeBin } from "@solow/claude-code/testing";
import { createLocalExecutor } from "../executor/local.js";
import { answerProbeTurn, probeHarness } from "./probe.js";

/**
 * "Does this harness work?", answered before a Task is queued rather than after one fails
 * (2026-08-28).
 *
 * The cases worth pinning are the ones an Owner actually hits: a command that was never
 * installed, one that starts but is not the harness it claims to be, and one that works — where
 * "works" has to include reading back what it advertises, because filling the model and mode
 * suggestions is half the point of probing at all.
 *
 * Real child processes through the real Executor, scripted rather than live (Principle VI).
 */

let workdir: string | undefined;

afterEach(async () => {
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = undefined;
});

async function dir(): Promise<string> {
  workdir = await mkdtemp(join(tmpdir(), "solow-probe-"));
  return workdir;
}

async function script(at: string, body: string): Promise<string> {
  const path = join(at, "fake-harness");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const base = (cwd: string) => ({ args: [], env: { PATH: process.env["PATH"] ?? "" }, cwd });

describe("probeHarness", () => {
  it("names a command that is not installed, which is the failure that actually happens", async () => {
    const cwd = await dir();

    const result = await probeHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command: join(cwd, "definitely-not-installed"),
      protocol: "claude_code_stream_json",
    });

    expect(result.ok).toBe(false);
    // Actionable, not a stack trace: the Owner's next move is to install it or fix the path.
    expect(result.reason).toContain("installed and on PATH");
  });

  it("accepts a plain CLI that starts, which is all a passthrough harness can promise", async () => {
    const cwd = await dir();
    const command = await script(cwd, "sleep 5");

    const result = await probeHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command,
      protocol: "cli_passthrough",
    });

    expect(result).toMatchObject({ ok: true, reason: null });
    // Nothing is claimed about a protocol that advertises nothing.
    expect(result.capabilities).toEqual({ models: [], modes: [] });
    expect(result.protocolVersion).toBeNull();
  });

  it("rejects a command that starts and dies at once", async () => {
    // How a missing interpreter or an unreadable binary reports itself — indistinguishable from
    // "installed" if the probe only checked that spawning did not throw.
    const cwd = await dir();
    const command = await script(cwd, "exit 127");

    const result = await probeHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command,
      protocol: "claude_code_stream_json",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("127");
  });

  it("completes the ACP handshake and reads back what the harness advertises", async () => {
    const cwd = await dir();
    const command = await writeFakeAcpBin(cwd, {});

    const result = await probeHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command,
      protocol: "acp",
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    // The negotiated version, not ours-as-asserted: a harness speaking an older one negotiates down.
    expect(result.protocolVersion).toBe(1);
  });

  it("reports which build answered the handshake", async () => {
    const cwd = await dir();
    const command = await writeFakeAcpBin(cwd, {
      agentInfo: { name: "OpenCode", version: "1.18.33" },
    });

    const result = await probeHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command,
      protocol: "acp",
      minVersion: "1.18.33",
    });

    expect(result.ok).toBe(true);
    expect(result.agent).toEqual({ name: "OpenCode", version: "1.18.33" });
  });

  it("fails a build below the catalog's pin in the words a run would fail it in", async () => {
    // The probe asks "would a Task on this Profile start?", so it must refuse what a run refuses —
    // and still say which build it found, so the Owner sees the version without a terminal.
    const cwd = await dir();
    const command = await writeFakeAcpBin(cwd, {
      agentInfo: { name: "OpenCode", version: "1.17.2" },
    });

    const result = await probeHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command,
      protocol: "acp",
      minVersion: "1.18.33",
      harnessName: "opencode",
      installHint: "npm install -g opencode-ai@latest",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(
      "opencode 1.17.2 is older than 1.18.33, the oldest version this build supports — upgrade it (npm install -g opencode-ai@latest)",
    );
    expect(result.agent).toEqual({ name: "OpenCode", version: "1.17.2" });
    expect(result.protocolVersion).toBe(1);
  });

  it("refuses a protocol this build cannot drive, without starting anything", async () => {
    const cwd = await dir();

    const result = await probeHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command: "irrelevant",
      protocol: "protocol_from_a_newer_build",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no runner for protocol");
  });

  it("gives up on a harness that never answers, rather than hanging the request", async () => {
    // An ACP-declared command that starts and says nothing is the worst case for a probe: there
    // is no error to read, only silence. The bound is what turns that into an answer.
    const cwd = await dir();
    const command = await script(cwd, "sleep 30");

    const result = await probeHarness(
      createLocalExecutor(cwd),
      { ...base(cwd), command, protocol: "acp" },
      // The real timeout is 20s; this asserts the mechanism, not the patience.
    );

    // Either it timed out or the peer reported the closed stream — both are a clean failure.
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  }, 30_000);

  it("says a missing command is missing, so a caller need not parse the sentence", async () => {
    const cwd = await dir();

    const result = await probeHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command: join(cwd, "definitely-not-installed"),
      protocol: "claude_code_stream_json",
    });

    expect(result.failure).toBe("missing");
  });
});

/**
 * The guided setup's test run (roadmap E1): a probe that passed, followed by one real prompt.
 *
 * What it has to catch is the case the bare probe cannot: Claude Code starts happily with any
 * token at all, and only a prompt makes the provider look at it. The fake CLI answers the way the
 * real one was observed to — the rejection arrives as assistant text and an `is_error` result
 * whose subtype still reads "success".
 */
describe("answerProbeTurn", () => {
  const passed = {
    ok: true,
    reason: null,
    protocolVersion: null,
    authMethods: [],
    agent: null,
    capabilities: { models: [], modes: [] },
  };

  async function turnWith(script: Parameters<typeof writeFakeClaudeBin>[1]) {
    const cwd = await dir();
    const command = await writeFakeClaudeBin(cwd, script);
    return answerProbeTurn(createLocalExecutor(cwd), passed, {
      ...base(cwd),
      command,
      protocol: "claude_code_stream_json",
    });
  }

  it("passes when the harness answers the prompt", async () => {
    const result = await turnWith({ turns: [{ text: ["ready"] }] });

    expect(result.ok).toBe(true);
    expect(result.answered).toBe(true);
  });

  it("names a refused credential as the credential", async () => {
    const result = await turnWith({
      turns: [{ text: ["Invalid API key · Fix external API key"] }],
      failWith: "success",
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("credential");
    // The CLI's own words, not the subtype that said "success" for a turn that failed.
    expect(result.reason).toContain("Invalid API key");
  });

  it("tells a spent plan apart from a bad credential", async () => {
    const result = await turnWith({
      turns: [{ text: ["Claude AI usage limit reached|1760000000"] }],
      failWith: "success",
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("quota");
  });

  it("does not claim an answer from a protocol it cannot prompt outside a run", async () => {
    const cwd = await dir();

    const result = await answerProbeTurn(createLocalExecutor(cwd), passed, {
      ...base(cwd),
      command: "never-started",
      protocol: "acp",
    });

    // The handshake stands as the result; nothing was spawned for a turn that cannot happen.
    expect(result.ok).toBe(true);
    expect(result.answered).toBe(false);
  });

  it("leaves a failed probe as it was, without spending a turn on it", async () => {
    const cwd = await dir();
    const failed = { ...passed, ok: false, reason: "no", failure: "missing" as const };

    const result = await answerProbeTurn(createLocalExecutor(cwd), failed, {
      ...base(cwd),
      command: "never-started",
      protocol: "claude_code_stream_json",
    });

    expect(result).toEqual({ ...failed, answered: false });
  });
});
