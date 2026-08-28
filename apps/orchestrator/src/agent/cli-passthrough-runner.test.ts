/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalExecutor } from "../executor/local.js";
import { CliPassthroughRunner } from "./cli-passthrough-runner.js";
import type { AgentHandle, AgentStreamEvent } from "./runner.js";

/**
 * A plain CLI as an agent (issue #21), driving a real child process through the real `Executor`
 * — a scripted shell script, never a live agent (Principle VI).
 *
 * What matters here is the contract the lifecycle depends on, which is deliberately smaller than
 * the other two runners': the brief reaches the command, its stdout becomes the transcript, its
 * exit status becomes the outcome, and stopping is not a failure. Everything absent is absent on
 * purpose — a passthrough agent has no tools, no permissions and no usage to report, and
 * inventing them from arbitrary stdout would be guessing.
 */

let handle: AgentHandle | undefined;
let workdir: string | undefined;

afterEach(async () => {
  await handle?.stop();
  handle = undefined;
  if (workdir) await rm(workdir, { recursive: true, force: true });
  workdir = undefined;
});

/** A fake agent: a shell script doing exactly what the test needs and nothing else. */
async function fakeAgent(dir: string, body: string): Promise<string> {
  const path = join(dir, "fake-agent");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function run(body: string, prompt = "fix the latch") {
  workdir = await mkdtemp(join(tmpdir(), "solow-passthrough-"));
  const events: AgentStreamEvent[] = [];
  const command = await fakeAgent(workdir, body);
  handle = new CliPassthroughRunner({ executor: createLocalExecutor(workdir) }).start({
    command,
    args: ["--flag"],
    cwd: workdir,
    env: { PATH: process.env["PATH"] ?? "" },
    // SoloW provisions the worktree for a passthrough agent, exactly as it does for ACP.
    worktreeName: null,
    prompt,
    onEvent: (e) => events.push(e),
  });
  return { events, workdir };
}

const transcript = (events: AgentStreamEvent[]) =>
  events
    .filter((e) => e.kind === "stdout")
    .map((e) => (e as { text: string }).text)
    .join("");

describe("CliPassthroughRunner", () => {
  it("hands the brief to the command and streams its stdout as the transcript", async () => {
    // `"$@"` is every argument: the catalog row's own, then the brief last.
    const { events } = await run('echo "args: $*"');

    const result = await handle?.outcome;
    expect(result).toEqual({ kind: "completed" });
    expect(transcript(events)).toContain("--flag");
    expect(transcript(events)).toContain("fix the latch");
  });

  it("reports the agent's text on the assistant channel and nothing else", async () => {
    // The smaller contract, asserted: no tool calls, no permissions, no usage invented from
    // stdout. A transcript that claimed a tool ran because a line looked like one would be
    // worse than a plain one.
    const { events } = await run('echo "I changed the file"');
    await handle?.outcome;

    expect(events.every((e) => e.kind === "stdout")).toBe(true);
    expect(events.every((e) => e.kind !== "stdout" || e.channel === "assistant")).toBe(true);
  });

  it("runs in the worktree it was given, and reports it", async () => {
    const { events, workdir: dir } = await run("pwd");
    await handle?.outcome;

    expect(await handle?.workspacePath).toBe(dir);
    // Not merely reported — actually where the process ran (Principle II).
    expect(transcript(events)).toContain(dir);
  });

  it("fails on a non-zero exit, and keeps stderr's reason out of the transcript", async () => {
    const { events } = await run('echo "partial work"; echo "boom" >&2; exit 3');

    expect(await handle?.outcome).toEqual({ kind: "failed", signal: {} });
    // stderr carries progress bars and warnings too; interleaving it would make the transcript
    // unreadable. The work the agent did say is still there.
    expect(transcript(events)).toContain("partial work");
    expect(transcript(events)).not.toContain("boom");
  });

  it("classifies a quota message on stderr as a park rather than a plain failure", async () => {
    // The same classification the other two runners apply, from the same `detectFailureSignal`.
    const { events } = await run('echo "usage limit reached" >&2; exit 1');
    await handle?.outcome;

    expect(await handle?.outcome).toEqual({ kind: "failed", signal: { quotaExhausted: true } });
    expect(transcript(events)).not.toContain("usage limit");
  });

  it("drains the output before answering, so a short run is not truncated", async () => {
    // `exited` resolves before the last chunks are read; an outcome reported then would cut off
    // the transcript it is about.
    const { events } = await run('for i in 1 2 3 4 5; do echo "line $i"; done');
    await handle?.outcome;

    expect(transcript(events)).toContain("line 1");
    expect(transcript(events)).toContain("line 5");
  });

  it("delivers operator input on stdin", async () => {
    const { events } = await run('read -r steer; echo "heard: $steer"');

    expect(await handle?.send("go left")).toBe(true);
    await handle?.outcome;
    expect(transcript(events)).toContain("heard: go left");
  });

  it("treats a stop as an ended run, never as a failure", async () => {
    // Partial work still reaches review — the same rule both other runners follow.
    await run("sleep 30");
    await handle?.stop();

    expect(await handle?.outcome).toEqual({ kind: "completed" });
  });
});
