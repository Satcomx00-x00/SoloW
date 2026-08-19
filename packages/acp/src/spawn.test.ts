/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSession, type AcpUpdate } from "./session.js";
import { type SpawnedAgent, spawnAcpAgent } from "./spawn.js";
import { FAKE_AGENT_MAIN, type FakeAgentScript } from "./testing.js";

/**
 * Process transport (task TASK-014). The agent here is a real child process speaking real ACP
 * over stdio, which is what makes the three acceptance criteria checkable: the child's
 * environment is exactly what we handed it, its updates arrive in order, and stopping it
 * terminates the process.
 */

let spawned: SpawnedAgent | undefined;
let workdir: string | undefined;

afterEach(async () => {
  await spawned?.kill();
  spawned = undefined;
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = undefined;
});

async function startAgent(script: FakeAgentScript, env: Record<string, string> = {}) {
  workdir = await mkdtemp(join(tmpdir(), "gatecontrol-acp-"));
  const updates: AcpUpdate[] = [];
  spawned = spawnAcpAgent({
    command: process.execPath,
    args: ["run", FAKE_AGENT_MAIN, JSON.stringify(script)],
    cwd: workdir,
    // Bun itself needs PATH to resolve; everything else is deliberately absent so the test can
    // assert the child sees only what we passed (Principle IV).
    env: { PATH: process.env["PATH"] ?? "", ...env },
  });
  const session = await AcpSession.connect(spawned.stream, {
    cwd: workdir,
    onUpdate: (u) => updates.push(u),
  });
  return { session, updates, workdir };
}

describe("spawnAcpAgent", () => {
  it("drives a real child process through a full prompt turn, in order", async () => {
    const { session, updates } = await startAgent({
      turns: [{ toolCalls: ["edit"], chunks: ["done: ", "latch fixed"] }],
    });

    expect(await session.prompt("fix the latch")).toBe("end_turn");
    expect(updates).toEqual([
      { kind: "tool_call", toolCallId: "tool-edit", title: "edit", status: "completed" },
      { kind: "text", channel: "agent", text: "done: " },
      { kind: "text", channel: "agent", text: "latch fixed" },
    ]);
  });

  it("gives the agent process only the environment it was handed", async () => {
    // A variable the orchestrator holds but never passes on. If the child could see it, the
    // agent would be inheriting our environment — and with it any other tenant's credential.
    process.env["GATECONTROL_SPAWN_LEAK_CHECK"] = "must-not-reach-the-agent";
    try {
      const { session, workdir: dir } = await startAgent(
        { turns: [{ writeEnvNames: "env.json" }] },
        { CLAUDE_CODE_OAUTH_TOKEN: "the-only-credential" },
      );
      await session.prompt("report your environment");

      const names: string[] = JSON.parse(await readFile(join(dir as string, "env.json"), "utf8"));
      expect(names).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(names).not.toContain("GATECONTROL_SPAWN_LEAK_CHECK");
      expect(names).not.toContain("ANTHROPIC_API_KEY");
    } finally {
      delete process.env["GATECONTROL_SPAWN_LEAK_CHECK"];
    }
  });

  it("terminates the agent process cleanly when stopped", async () => {
    const { session } = await startAgent({ turns: [{ chunks: ["working"] }] });
    await session.prompt("start");

    // The fixture stays alive until its stdio is closed or it is killed — a real agent does
    // the same, so "stop" has to actually end the process rather than just drop the stream.
    const exited = await (spawned as SpawnedAgent).kill();
    expect(typeof exited).toBe("number");
    session.close();
  });
});
