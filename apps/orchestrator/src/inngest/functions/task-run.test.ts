/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import type { ExecutorConfig } from "@gatecontrol/contracts";
import {
  agentProfile,
  encryptSecret,
  executorProfile,
  issue,
  repository,
  secret,
  session,
  sessionEvent,
  task,
  workspace,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { createLogger } from "@gatecontrol/observability";
import { asc, eq } from "drizzle-orm";
import { AgentRegistry } from "../../agent/registry.js";
import type { AgentHandle, AgentOutcome, AgentRunner, AgentStartOpts } from "../../agent/runner.js";
import { listTaskEventsSince } from "../../data.js";
import { runTaskLifecycle, type StepLike, type TaskRunDeps } from "./task-run.js";

/**
 * Orchestrator lifecycle integration test (task TASK-020). Drives `runTaskLifecycle` against a
 * real in-memory DB with a fake ACP agent and a controllable step, verifying approve/reject/
 * request-changes, park-on-quota, hard-failure (worktree preserved), and cross-Task isolation
 * (Principles I, II, III). Uses the injectable deps rather than a live Inngest engine.
 */

interface Ids {
  workspaceId: string;
  taskId: string;
  sessionId: string;
}

let counter = 0;
function freshIds(): Ids {
  counter += 1;
  return {
    workspaceId: `ws-${counter}`,
    taskId: `task-${counter}`,
    sessionId: `sess-${counter}`,
  };
}

async function seedRun(
  db: TestDb,
  ids: Ids,
  opts: { executorConfig?: ExecutorConfig } = {},
): Promise<void> {
  await db.insert(workspace).values({ id: ids.workspaceId, name: "WS", ownerUserId: "owner" });
  const secretId = `secret-${ids.taskId}`;
  await db.insert(secret).values({
    id: secretId,
    workspaceId: ids.workspaceId,
    name: "sub",
    kind: "subscription_token",
    ciphertext: encryptSecret("oauth-token"),
  });
  const agentId = `agent-${ids.taskId}`;
  await db.insert(agentProfile).values({
    id: agentId,
    workspaceId: ids.workspaceId,
    name: "Claude",
    authMode: "subscription",
    secretId,
    concurrencyCap: 3,
  });
  const executorId = `exec-${ids.taskId}`;
  const executorConfig: ExecutorConfig = opts.executorConfig ?? { kind: "local", env: {} };
  await db.insert(executorProfile).values({
    id: executorId,
    workspaceId: ids.workspaceId,
    name: "Local",
    kind: executorConfig.kind,
    config: executorConfig,
  });
  const repoId = `repo-${ids.taskId}`;
  await db.insert(repository).values({
    id: repoId,
    workspaceId: ids.workspaceId,
    name: "repo",
    source: "local_path",
    location: `/srv/${ids.taskId}`,
  });
  const issueId = `issue-${ids.taskId}`;
  await db
    .insert(issue)
    .values({ id: issueId, workspaceId: ids.workspaceId, title: "Issue", status: "open" });
  await db.insert(task).values({
    id: ids.taskId,
    workspaceId: ids.workspaceId,
    issueId,
    title: "Task",
    state: "running",
    agentProfileId: agentId,
    executorProfileId: executorId,
    repositoryId: repoId,
    baseRef: "main",
  });
  await db.insert(session).values({
    id: ids.sessionId,
    workspaceId: ids.workspaceId,
    taskId: ids.taskId,
    state: "active",
  });
}

async function taskState(db: TestDb, taskId: string): Promise<string> {
  const [row] = await db.select().from(task).where(eq(task.id, taskId)).limit(1);
  return row?.state ?? "MISSING";
}

/** A review decision, optionally with the feedback the reviewer wrote. */
type ScriptedDecision = string | null | { decision: string; feedback: string };

/** A step that runs work inline and replays a scripted list of review decisions. */
function scriptedStep(decisions: ScriptedDecision[]): StepLike {
  const queue = [...decisions];
  return {
    run: async (_id, fn) => fn(),
    waitForEvent: async (_id, opts) => {
      const next = queue.shift();
      if (next === undefined || next === null) return null;
      const decided = typeof next === "string" ? { decision: next } : next;
      return { data: { sessionId: opts.match, ...decided } };
    },
    sleepUntil: async () => {},
  };
}

/** Fake agent runner returning queued outcomes; records how many times it started. */
class ScriptedRunner implements AgentRunner {
  starts = 0;
  /** The brief each run was given, in order. */
  readonly prompts: string[] = [];
  /** The environment each run was handed — where the billing guard's output is observable. */
  readonly envs: Record<string, string>[] = [];
  constructor(private readonly outcomes: AgentOutcome[]) {}
  start(opts: AgentStartOpts): AgentHandle {
    this.starts += 1;
    this.prompts.push(opts.prompt);
    this.envs.push(opts.env);
    opts.onEvent({ kind: "stdout", text: "working" });
    const outcome = this.outcomes.shift() ?? { kind: "completed" };
    return {
      outcome: Promise.resolve(outcome),
      // The worktree the agent reports: the one it was asked to create, or — when resuming —
      // the one it is already running in.
      workspacePath: Promise.resolve<string | null>(
        opts.worktreeName ? `/wt/${opts.worktreeName}` : opts.cwd,
      ),
      send: async () => true,
      stop: async () => {},
    };
  }
}

interface Spies {
  commit: number;
  discard: number;
  cleanup: number;
  published: Array<{ channel: string; event: Record<string, unknown> }>;
}

function makeDeps(
  db: TestDb,
  runner: AgentRunner,
  logStream: NodeJS.WritableStream,
): { deps: TaskRunDeps; spies: Spies } {
  const spies: Spies = { commit: 0, discard: 0, cleanup: 0, published: [] };
  const deps: TaskRunDeps = {
    db,
    runner,
    worktreeRoot: "/wt",
    repoCacheRoot: "/cache",
    logger: createLogger({ service: "orchestrator", destination: logStream }),
    worktree: {
      prepare: async (p) => `/repo/${p.taskId}`,
      // Stands in for git confirming the agent's worktree really belongs to the repository.
      adopt: async (repoPath, reported) => {
        if (!reported) throw new Error("agent did not report a workspace");
        // `claude --worktree <name>` names the branch after the worktree, and the real `adopt`
        // reads whatever git reports; the fake mirrors that shape.
        return { path: reported, branch: reported.split("/").pop() ?? "", repoPath };
      },
      commit: async () => {
        spies.commit += 1;
      },
      discard: async () => {
        spies.discard += 1;
      },
      cleanup: async () => {
        spies.cleanup += 1;
      },
      hasChanges: async () => true,
      diff: async () => ({
        files: [{ path: "src/latch.ts", status: "modified" as const, additions: 4, deletions: 1 }],
        patch: "--- a/src/latch.ts\n+++ b/src/latch.ts\n",
        truncated: false,
      }),
    },
    hub: {
      taskChannel: (w, t) => `ws:${w}:task:${t}`,
      boardChannel: (w) => `ws:${w}:board`,
      publish: (channel, event) =>
        spies.published.push({ channel, event: event as Record<string, unknown> }),
    },
    registry: new AgentRegistry(),
    agentInvocation: () => ({ command: "fake", args: [] }),
  };
  return { deps, spies };
}

function nullStream(): NodeJS.WritableStream {
  return new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
}

describe("runTaskLifecycle (integration)", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });

  beforeEach(() => {
    db = createTestDb();
  });

  it("approve → commits onto a branch and marks the Task Done (Principle I)", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("done");
    expect(await taskState(db, ids.taskId)).toBe("done");
    expect(spies.commit).toBe(1);
    expect(spies.discard).toBe(0);
    expect(spies.cleanup).toBe(1);
  });

  it("reject → discards worktree changes and returns the Task to Ready", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["reject"]) });

    expect(await taskState(db, ids.taskId)).toBe("ready");
    expect(spies.discard).toBe(1);
    expect(spies.commit).toBe(0);
  });

  it("request_changes loops the agent, then approve completes it", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["request_changes", "approve"]),
    });

    expect(runner.starts).toBe(2); // one per round
    expect(await taskState(db, ids.taskId)).toBe("done");
    expect(spies.commit).toBe(1);
  });

  it("quota exhaustion Parks then resumes within the same run (Principle III / FR-016)", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    // Round 0 fails with quota → park; round 1 completes → review → approve.
    const runner = new ScriptedRunner([
      { kind: "failed", signal: { quotaExhausted: true } },
      { kind: "completed" },
    ]);
    const { deps } = makeDeps(db, runner, nullStream());

    let sleeps = 0;
    const step: StepLike = {
      ...scriptedStep(["approve"]),
      sleepUntil: async () => {
        sleeps += 1;
      },
    };

    const result = await runTaskLifecycle(deps, { event: { data: ids }, step });

    expect(sleeps).toBe(1); // parked once
    expect(result.result).toBe("done");
    expect(await taskState(db, ids.taskId)).toBe("done");
  });

  it("hard failure → Task Failed with the worktree preserved (not cleaned)", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "failed", signal: {} }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep([]),
    });

    expect(result.result).toBe("fail");
    expect(await taskState(db, ids.taskId)).toBe("failed");
    expect(spies.cleanup).toBe(0); // worktree preserved for retry
    expect(spies.commit).toBe(0);
  });

  it("concurrent Tasks are isolated — one Task's failure does not affect the other", async () => {
    const a = freshIds();
    const b = freshIds();
    await seedRun(db, a);
    await seedRun(db, b);

    const depsA = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());
    const depsB = makeDeps(db, new ScriptedRunner([{ kind: "failed", signal: {} }]), nullStream());

    const [resA, resB] = await Promise.all([
      runTaskLifecycle(depsA.deps, { event: { data: a }, step: scriptedStep(["approve"]) }),
      runTaskLifecycle(depsB.deps, { event: { data: b }, step: scriptedStep([]) }),
    ]);

    expect(resA.result).toBe("done");
    expect(resB.result).toBe("fail");
    expect(await taskState(db, a.taskId)).toBe("done");
    expect(await taskState(db, b.taskId)).toBe("failed");
  });

  it("persists streamed agent events so a reconnecting client can replay them (TASK-018)", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // Filtered to stdout: the log also carries the diff captured at the review gate.
    const logged = (
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, ids.sessionId))
    ).filter((e) => e.kind === "stdout");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.seq).toBe(0);
    expect(logged[0]?.payload).toEqual({ text: "working" });
    expect(logged[0]?.workspaceId).toBe(ids.workspaceId);
  });

  it("numbers events across rounds so replay resumes where the client left off", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["request_changes", "approve"]),
    });

    const logged = (
      await db
        .select()
        .from(sessionEvent)
        .where(eq(sessionEvent.sessionId, ids.sessionId))
        .orderBy(asc(sessionEvent.seq))
    ).filter((e) => e.kind === "stdout");
    expect(logged.map((e) => e.seq)).toEqual([0, 2]);

    // Every event shares one `seq` sequence, diffs included, so a client resuming from a
    // cursor gets each of them exactly once and in order.
    const missed = await listTaskEventsSince(db, ids.workspaceId, ids.taskId, 0);
    expect(missed.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("announces Task state changes on the Workspace board channel", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const board = spies.published.filter((p) => p.channel === `ws:${ids.workspaceId}:board`);
    expect(board.map((p) => p.event["state"])).toEqual(["review", "done"]);
    // Task-scoped output never leaks onto the Workspace-wide board channel.
    expect(board.every((p) => p.event["kind"] === "status")).toBe(true);
  });

  it("a Task's events are invisible to another Workspace's replay (Principle V)", async () => {
    const a = freshIds();
    const b = freshIds();
    await seedRun(db, a);
    await seedRun(db, b);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: a }, step: scriptedStep(["approve"]) });

    // One stdout line plus the diff captured at the review gate.
    expect(await listTaskEventsSince(db, a.workspaceId, a.taskId, -1)).toHaveLength(2);
    expect(await listTaskEventsSince(db, b.workspaceId, a.taskId, -1)).toHaveLength(0);
  });

  it("emits the worktree→task audit binding with no secret value in the logs (Principle IV)", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const lines: Record<string, unknown>[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        for (const line of chunk.toString().split("\n"))
          if (line.trim()) lines.push(JSON.parse(line));
        cb();
      },
    });
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), stream);

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const events = lines.map((l) => l.event).filter(Boolean);
    expect(events).toContain("worktree.bound");
    expect(events).toContain("state.transition");
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("oauth-token");
  });
});

describe("the brief the agent is given", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });
  beforeEach(() => {
    db = createTestDb();
  });

  it("carries the reviewer's feedback into the next round", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep([
        { decision: "request_changes", feedback: "Add a regression test for the latch." },
        "approve",
      ]),
    });

    expect(runner.prompts).toHaveLength(2);
    // Without this the second round repeats the first brief verbatim and the agent has no
    // reason to produce anything different — request-changes would be a no-op loop.
    expect(runner.prompts[0]).not.toContain("Add a regression test");
    expect(runner.prompts[1]).toContain("Add a regression test for the latch.");
  });

  it("describes the Task and its Issue so the agent knows what to do", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(runner.prompts[0]).toContain("Task");
    expect(runner.prompts[0]).toContain("Issue");
  });

  it("publishes the running agent so the terminal can steer it, and withdraws it after", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const registry = new AgentRegistry();
    const seen: boolean[] = [];
    // A runner that checks, from inside the run, whether the hub could have found it.
    const runner: AgentRunner = {
      start(opts: AgentStartOpts): AgentHandle {
        opts.onEvent({ kind: "stdout", text: "working" });
        return {
          outcome: Promise.resolve({ kind: "completed" } as AgentOutcome).then((o) => {
            seen.push(registry.get(ids.workspaceId, ids.taskId) !== undefined);
            return o;
          }),
          workspacePath: Promise.resolve<string | null>(
            opts.worktreeName ? `/wt/${opts.worktreeName}` : opts.cwd,
          ),
          send: async () => true,
          stop: async () => {},
        };
      },
    };
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(
      { ...deps, registry },
      {
        event: { data: ids },
        step: scriptedStep(["approve"]),
      },
    );

    expect(seen).toEqual([true]);
    // Once the run is over there is no agent to steer, and a stale handle would let the
    // terminal appear to send input into a dead process.
    expect(registry.get(ids.workspaceId, ids.taskId)).toBeUndefined();
  });
});

describe("the diff a reviewer is shown", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });
  beforeEach(() => {
    db = createTestDb();
  });

  it("is captured at the review gate and persisted to the session log", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const [captured] = (
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, ids.sessionId))
    ).filter((e) => e.kind === "diff");
    expect(captured).toBeDefined();
    expect(captured?.payload).toMatchObject({
      diffRef: `gatecontrol-task-${ids.taskId}`,
      files: [{ path: "src/latch.ts", status: "modified", additions: 4, deletions: 1 }],
      truncated: false,
    });
  });

  it("survives the worktree being removed, so an approved Task can still show its change", async () => {
    // Approving commits and then tears the worktree down. If the diff were read on demand from
    // disk it would be gone by the time anyone looked at the finished Task.
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(spies.cleanup).toBe(1);
    const stored = (
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, ids.sessionId))
    ).filter((e) => e.kind === "diff");
    expect(stored).toHaveLength(1);
  });

  it("a capture failure does not block the review gate", async () => {
    // The branch name alone is enough to decide on, so a git hiccup must degrade to "no diff
    // shown" rather than stranding the Task short of the gate.
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());
    const failing: TaskRunDeps = {
      ...deps,
      worktree: {
        ...deps.worktree,
        diff: async () => {
          throw new Error("git exploded");
        },
      },
    };

    const result = await runTaskLifecycle(failing, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("done");
    expect(await taskState(db, ids.taskId)).toBe("done");
    const diffs = (
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, ids.sessionId))
    ).filter((e) => e.kind === "diff");
    expect(diffs).toHaveLength(0);
  });

  describe("executor profile configuration (issue #73)", () => {
    it("fails a Task whose Executor kind has no driver, rather than running it on the host", async () => {
      const ids = freshIds();
      await seedRun(db, ids, {
        executorConfig: { kind: "docker", image: "oven/bun:1.3", mounts: [], env: {} },
      });
      const runner = new ScriptedRunner([{ kind: "completed" }]);
      const { deps, spies } = makeDeps(db, runner, nullStream());

      const result = await runTaskLifecycle(deps, {
        event: { data: ids },
        step: scriptedStep(["approve"]),
      });

      expect(result.result).toBe("failed");
      expect(await taskState(db, ids.taskId)).toBe("failed");
      // The user asked for a container. Running the agent anywhere else and reporting success
      // would be the product silently ignoring the isolation it was asked for.
      expect(runner.starts).toBe(0);
      expect(spies.commit).toBe(0);
      const [row] = await db.select().from(task).where(eq(task.id, ids.taskId)).limit(1);
      expect(row?.failureReason).toContain("docker");
    });

    it("hands the profile's environment to the agent process", async () => {
      const ids = freshIds();
      await seedRun(db, ids, {
        executorConfig: { kind: "local", env: { BUILD_FLAVOUR: "debug" } },
      });
      const runner = new ScriptedRunner([{ kind: "completed" }]);
      const { deps } = makeDeps(db, runner, nullStream());

      await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

      expect(runner.envs[0]?.["BUILD_FLAVOUR"]).toBe("debug");
    });

    it("AC-6: a profile environment cannot divert the run to metered billing", async () => {
      const ids = freshIds();
      // The contract refuses such a profile; this row stands in for one written before that
      // check existed, and proves the guard is still the last word.
      await seedRun(db, ids, {
        executorConfig: {
          kind: "local",
          env: { ANTHROPIC_API_KEY: "sk-metered" } as Record<string, string>,
        },
      });
      const runner = new ScriptedRunner([{ kind: "completed" }]);
      const { deps } = makeDeps(db, runner, nullStream());

      await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

      expect(runner.envs[0]).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(runner.envs[0]?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-token");
    });
  });
});
