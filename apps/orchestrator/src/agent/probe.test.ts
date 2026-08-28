/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeAcpBin } from "@solow/acp/testing";
import { createLocalExecutor } from "../executor/local.js";
import { probeAgent } from "./probe.js";

/**
 * "Does this agent work?", answered before a Task is queued rather than after one fails
 * (2026-08-28).
 *
 * The cases worth pinning are the ones an Owner actually hits: a command that was never
 * installed, one that starts but is not the agent it claims to be, and one that works — where
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
  const path = join(at, "fake-agent");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const base = (cwd: string) => ({ args: [], env: { PATH: process.env["PATH"] ?? "" }, cwd });

describe("probeAgent", () => {
  it("names a command that is not installed, which is the failure that actually happens", async () => {
    const cwd = await dir();

    const result = await probeAgent(createLocalExecutor(cwd), {
      ...base(cwd),
      command: join(cwd, "definitely-not-installed"),
      protocol: "claude_code_stream_json",
    });

    expect(result.ok).toBe(false);
    // Actionable, not a stack trace: the Owner's next move is to install it or fix the path.
    expect(result.reason).toContain("installed and on PATH");
  });

  it("accepts a plain CLI that starts, which is all a passthrough agent can promise", async () => {
    const cwd = await dir();
    const command = await script(cwd, "sleep 5");

    const result = await probeAgent(createLocalExecutor(cwd), {
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

    const result = await probeAgent(createLocalExecutor(cwd), {
      ...base(cwd),
      command,
      protocol: "claude_code_stream_json",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("127");
  });

  it("completes the ACP handshake and reads back what the agent advertises", async () => {
    const cwd = await dir();
    const command = await writeFakeAcpBin(cwd, {});

    const result = await probeAgent(createLocalExecutor(cwd), {
      ...base(cwd),
      command,
      protocol: "acp",
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    // The negotiated version, not ours-as-asserted: an agent speaking an older one negotiates down.
    expect(result.protocolVersion).toBe(1);
  });

  it("refuses a protocol this build cannot drive, without starting anything", async () => {
    const cwd = await dir();

    const result = await probeAgent(createLocalExecutor(cwd), {
      ...base(cwd),
      command: "irrelevant",
      protocol: "protocol_from_a_newer_build",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no runner for protocol");
  });

  it("gives up on an agent that never answers, rather than hanging the request", async () => {
    // An ACP-declared command that starts and says nothing is the worst case for a probe: there
    // is no error to read, only silence. The bound is what turns that into an answer.
    const cwd = await dir();
    const command = await script(cwd, "sleep 30");

    const result = await probeAgent(
      createLocalExecutor(cwd),
      { ...base(cwd), command, protocol: "acp" },
      // The real timeout is 20s; this asserts the mechanism, not the patience.
    );

    // Either it timed out or the peer reported the closed stream — both are a clean failure.
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  }, 30_000);
});
