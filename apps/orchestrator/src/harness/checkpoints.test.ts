/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointRelay, HOOK_SCRIPT, hookMatcher, toolCallFacts } from "./checkpoints.js";
import type { HarnessStreamEvent } from "./runner.js";

/**
 * Workflow checkpoints on Claude Code (review analysis, point 4), end to end on the host: the
 * real `hook.sh` under a real `sh`, the relay watching the same directory, and the operator's
 * answer arriving through the same inbox ACP permissions use. What matters is the contract the
 * CLI depends on — a call no rule watches is waved through at once with no opinion, a watched
 * one blocks until a person decides, and nobody deciding is a refusal.
 */

let store: string | undefined;
let relay: CheckpointRelay | undefined;

afterEach(async () => {
  relay?.close();
  relay = undefined;
  if (store) await rm(store, { recursive: true, force: true });
  store = undefined;
});

const PUSH = { on: "command" as const, match: "\\bgit push\\b", label: "Pushes" };
const SCHEMA = { on: "write" as const, match: "**/migrations/**", label: "Writes a migration" };

async function arm(rules = [PUSH, SCHEMA], deadlineMs?: number) {
  store = await mkdtemp(join(tmpdir(), "solow-checkpoints-"));
  const events: HarnessStreamEvent[] = [];
  relay = new CheckpointRelay({
    store,
    rules,
    onEvent: (e) => events.push(e),
    runTag: "run1",
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  relay.start();
  return { relay, events, store };
}

/** The hook as the CLI runs it: the tool call on stdin, its verdict on stdout. */
async function hook(dir: string, input: unknown): Promise<string> {
  const proc = Bun.spawn(["sh", join(dir, "hook.sh")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(input));
  await proc.stdin.end();
  return new Response(proc.stdout).text();
}

async function until<T>(read: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
}

const request = (events: HarnessStreamEvent[]) =>
  events.find(
    (e): e is Extract<HarnessStreamEvent, { kind: "permission_request" }> =>
      e.kind === "permission_request",
  );

describe("CheckpointRelay", () => {
  it("installs a hook the CLI can run, on exactly the tools the rules watch", async () => {
    const { relay, store } = await arm();
    const settings = JSON.parse(relay.settings) as {
      hooks: { PreToolUse: { matcher: string; hooks: { command: string; timeout: number }[] }[] };
    };
    const [installed] = settings.hooks.PreToolUse;
    expect(installed?.matcher).toBe("Bash|Edit|Write|MultiEdit|NotebookEdit");
    expect(installed?.hooks[0]?.command).toBe(`sh ${join(store, "hook.sh")}`);
    // The CLI proceeds as if there were no hook once its timeout passes, so the hook's timeout
    // has to outlast the two minutes a person gets — otherwise a slow answer is a silent grant.
    expect(installed?.hooks[0]?.timeout).toBeGreaterThan(120);
    expect(await readdir(store)).toContain("hook.sh");
  });

  it("waves a call no rule watches through at once, with no opinion", async () => {
    const { events, store } = await arm();
    const out = await hook(store, { tool_name: "Bash", tool_input: { command: "bun test" } });
    expect(JSON.parse(out)).toEqual({});
    expect(request(events)).toBeUndefined();
    // Nothing left behind for the next call to trip over.
    expect((await readdir(store)).filter((n) => n !== "hook.sh")).toEqual([]);
  });

  it("stops a watched call until the operator allows it, and records both halves", async () => {
    const { relay, events, store } = await arm();
    const verdict = hook(store, {
      tool_name: "Bash",
      tool_input: { command: "git push origin feature" },
      cwd: "/wt/task-1",
    });
    const asked = await until(() => request(events));
    // Surfaced before it is answered: the title says why and what, never the whole tool input.
    expect(asked.title).toBe("Pushes: git push origin feature");
    expect(asked.toolKind).toBe("Bash");
    expect(asked.options.map((o) => o.optionId)).toEqual(["allow", "deny"]);
    expect(asked.requestId.startsWith("checkpoint:run1:")).toBe(true);

    expect(relay.answer(asked.requestId, "maybe")).toBe("option_not_offered");
    expect(relay.answer("checkpoint:run1:nope", "allow")).toBe("not_pending");
    expect(relay.answer(asked.requestId, "allow")).toBe("answered");

    const out = JSON.parse(await verdict) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Pushes");
    const resolved = events.find((e) => e.kind === "permission_resolved");
    expect(resolved).toMatchObject({
      requestId: asked.requestId,
      optionId: "allow",
      decidedBy: "operator",
    });
  });

  it("denies when the operator says no, telling the harness to leave it undone", async () => {
    const { relay, events, store } = await arm();
    const verdict = hook(store, {
      tool_name: "Write",
      tool_input: { file_path: "/wt/task-1/packages/db/migrations/0040.sql", content: "SECRET" },
      cwd: "/wt/task-1",
    });
    const asked = await until(() => request(events));
    expect(asked.title).toBe("Writes a migration: /wt/task-1/packages/db/migrations/0040.sql");
    // The file's contents are in the tool input and nowhere in what was published.
    expect(JSON.stringify(events)).not.toContain("SECRET");
    relay.answer(asked.requestId, "deny");
    const out = JSON.parse(await verdict) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("reviewer refused");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("open item");
  });

  it("refuses when nobody answers in time — a checkpoint is never a silent grant", async () => {
    const { events, store } = await arm([PUSH], 150);
    const out = JSON.parse(
      await hook(store, { tool_name: "Bash", tool_input: { command: "git push" } }),
    ) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("Nobody answered");
    expect(events.find((e) => e.kind === "permission_resolved")).toMatchObject({
      optionId: null,
      decidedBy: "policy",
    });
    // Said in words on the transcript too, where a reviewer reads the run afterwards.
    expect(events.some((e) => e.kind === "stdout" && e.text.includes("refused by policy"))).toBe(
      true,
    );
  });

  it("refuses whatever is still open when the run ends, so no hook waits on nobody", async () => {
    const { relay, events, store } = await arm();
    const verdict = hook(store, { tool_name: "Bash", tool_input: { command: "git push" } });
    await until(() => request(events));
    relay.close();
    const out = JSON.parse(await verdict) as { hookSpecificOutput: { permissionDecision: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("clears the leftovers of a round that died mid-question", async () => {
    store = await mkdtemp(join(tmpdir(), "solow-checkpoints-"));
    await Bun.write(join(store, "1-1.request"), "{}");
    await Bun.write(join(store, "1-1.answer"), "{}");
    relay = new CheckpointRelay({ store, rules: [PUSH], onEvent: () => {}, runTag: "r" });
    expect((await readdir(store)).sort()).toEqual(["hook.sh"]);
  });
});

describe("toolCallFacts", () => {
  it("reads the command of a shell call and the path of a file call, and nothing of the rest", () => {
    expect(toolCallFacts("Bash", { command: "ls", description: "list" })).toEqual({
      command: "ls",
    });
    expect(toolCallFacts("Write", { file_path: "/a/b.ts", content: "x" })).toEqual({
      path: "/a/b.ts",
    });
    expect(toolCallFacts("NotebookEdit", { notebook_path: "/n.ipynb" })).toEqual({
      path: "/n.ipynb",
    });
    expect(toolCallFacts("Read", { file_path: "/a/b.ts" })).toEqual({});
  });
});

describe("hookMatcher", () => {
  it("names only the tools the rules can fire on", () => {
    expect(hookMatcher([PUSH])).toBe("Bash");
    expect(hookMatcher([SCHEMA])).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(hookMatcher([PUSH, SCHEMA])).toBe("Bash|Edit|Write|MultiEdit|NotebookEdit");
  });
});

describe("HOOK_SCRIPT", () => {
  it("is POSIX sh that gives up, with no opinion, once its bound passes", () => {
    expect(HOOK_SCRIPT.startsWith("#!/bin/sh")).toBe(true);
    expect(HOOK_SCRIPT).not.toContain("[[");
    expect(HOOK_SCRIPT).toContain("exit 0");
  });
});
