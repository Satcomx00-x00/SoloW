/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeClaudeBin } from "@solow/claude-code/testing";
import { createLocalExecutor } from "../executor/local.js";
import { explainWithHarness } from "./explain.js";

/**
 * One answer from the Task's own harness, outside any run. What is asserted is the contract
 * the Brief tab's Explain rests on: the answer is the harness's result text, the process is
 * driven for one turn with the instruction appended and nothing else, and every way it can
 * fail comes back as a reason an Owner can act on rather than a hang or a stack trace.
 */

const dirs: string[] = [];
async function dir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "solow-explain-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const base = (cwd: string) => ({
  args: [] as string[],
  env: { PATH: process.env.PATH ?? "" },
  cwd,
  protocol: "claude_code_stream_json",
  system: "Explain for a product owner.",
  prompt: "# Criterion AC-1\nA pure function lives in apps/crawler.",
});

describe("explainWithHarness", () => {
  it("returns the harness's answer for one print turn", async () => {
    const cwd = await dir();
    const command = await writeFakeClaudeBin(cwd, {
      turns: [{ text: ["**What it means** — the crawler judges each article it fetched."] }],
    });

    const result = await explainWithHarness(createLocalExecutor(cwd), { ...base(cwd), command });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("judges each article");
    expect(result.failure).toBeNull();
  });

  it("says when the harness cannot be started, in words an Owner can act on", async () => {
    const cwd = await dir();

    const result = await explainWithHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command: join(cwd, "definitely-not-installed"),
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("harness");
    expect(result.reason).toContain("installed and on PATH");
  });

  it("refuses a protocol this build cannot drive for an answer, rather than hanging", async () => {
    const cwd = await dir();

    const result = await explainWithHarness(createLocalExecutor(cwd), {
      ...base(cwd),
      command: "irrelevant",
      protocol: "acp",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('protocol "acp"');
  });

  it("reports a harness that failed its turn", async () => {
    const cwd = await dir();
    const command = await writeFakeClaudeBin(cwd, { failWith: "error_during_execution" });

    const result = await explainWithHarness(createLocalExecutor(cwd), { ...base(cwd), command });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("harness");
    expect(result.reason).toBeTruthy();
  });
});
