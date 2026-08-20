/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import type { AgentProtocol, ExecutorConfig } from "@gatecontrol/contracts";
import {
  agentCatalog,
  agentProfile,
  encryptSecret,
  executorProfile,
  issue,
  repository,
  secret,
  session,
  sessionEvent,
  task,
  taskDependency,
  workspace,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { createLogger } from "@gatecontrol/observability";
import { asc, eq } from "drizzle-orm";
import { worktreeNameForTask } from "../../agent/claude-code-runner.js";
import { AgentRegistry } from "../../agent/registry.js";
import type {
  AgentHandle,
  AgentOutcome,
  AgentRunner,
  AgentStartOpts,
  AgentStreamEvent,
} from "../../agent/runner.js";
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
  opts: {
    agentProtocol?: AgentProtocol;
    executorConfig?: ExecutorConfig;
    setupFilePatterns?: string[];
  } = {},
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
  const catalogId = `catalog-${ids.taskId}`;
  await db.insert(agentCatalog).values({
    id: catalogId,
    workspaceId: ids.workspaceId,
    key: "claude_code",
    displayName: "Claude Code",
    protocol: opts.agentProtocol ?? "claude_code_stream_json",
    command: "fake",
    subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  });
  const agentId = `agent-${ids.taskId}`;
  await db.insert(agentProfile).values({
    id: agentId,
    workspaceId: ids.workspaceId,
    name: "Claude",
    agentCatalogId: catalogId,
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
    ...(opts.setupFilePatterns ? { setupFilePatterns: opts.setupFilePatterns } : {}),
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

async function taskFailureReason(db: TestDb, taskId: string): Promise<string> {
  const [row] = await db.select().from(task).where(eq(task.id, taskId)).limit(1);
  return row?.failureReason ?? "";
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
  /** The command and environment each run was launched with — where the catalog row and the
   * billing guard's output become observable. */
  readonly commands: string[] = [];
  readonly envs: Record<string, string>[] = [];
  /** Where each run was pointed, and what worktree it was asked to make (null = none). */
  readonly cwds: string[] = [];
  readonly worktreeNames: (string | null)[] = [];
  constructor(
    private readonly outcomes: AgentOutcome[],
    /** Events each run emits, so a test can script an agent asking for a permission (#58). */
    private readonly events: AgentStreamEvent[] = [{ kind: "stdout", text: "working" }],
  ) {}
  start(opts: AgentStartOpts): AgentHandle {
    this.starts += 1;
    this.prompts.push(opts.prompt);
    this.commands.push(opts.command);
    this.envs.push(opts.env);
    this.cwds.push(opts.cwd);
    this.worktreeNames.push(opts.worktreeName);
    for (const event of this.events) opts.onEvent(event);
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
  /** Every setup-file copy the lifecycle asked for (issue #52), in order. */
  seeded: Array<{ repoPath: string; worktreePath: string; patterns: string[] }>;
  /** Worktrees GateControl created itself, for a protocol whose agent cannot (issue #58). */
  provisioned: string[];
  /** The patterns each diff/commit was told to exclude — how AC-4 becomes observable. */
  excluded: string[][];
}

function makeDeps(
  db: TestDb,
  runner: AgentRunner,
  logStream: NodeJS.WritableStream,
): { deps: TaskRunDeps; spies: Spies } {
  const spies: Spies = {
    commit: 0,
    discard: 0,
    cleanup: 0,
    published: [],
    seeded: [],
    provisioned: [],
    excluded: [],
  };
  const deps: TaskRunDeps = {
    db,
    runner: () => runner,
    worktreeRoot: "/wt",
    repoCacheRoot: "/cache",
    logger: createLogger({ service: "orchestrator", destination: logStream }),
    worktree: {
      prepare: async (p) => `/repo/${p.taskId}`,
      provision: async (p) => {
        const path = `/wt/gatecontrol-task-${p.taskId}`;
        spies.provisioned.push(path);
        return { path, branch: `gatecontrol/task-${p.taskId}`, repoPath: `/repo/${p.taskId}` };
      },
      // Stands in for git confirming the agent's worktree really belongs to the repository.
      adopt: async (repoPath, reported) => {
        if (!reported) throw new Error("agent did not report a workspace");
        // `claude --worktree <name>` names the branch after the worktree, and the real `adopt`
        // reads whatever git reports; the fake mirrors that shape.
        return { path: reported, branch: reported.split("/").pop() ?? "", repoPath };
      },
      seed: async (params) => {
        spies.seeded.push(params);
        return { copied: params.patterns.length, unmatched: [], failed: 0 };
      },
      commit: async (_path, _message, patterns) => {
        spies.commit += 1;
        spies.excluded.push(patterns);
      },
      discard: async () => {
        spies.discard += 1;
      },
      cleanup: async () => {
        spies.cleanup += 1;
      },
      hasChanges: async () => true,
      diff: async (_path, patterns) => {
        spies.excluded.push(patterns);
        return {
          files: [
            { path: "src/latch.ts", status: "modified" as const, additions: 4, deletions: 1 },
          ],
          patch: "--- a/src/latch.ts\n+++ b/src/latch.ts\n",
          truncated: false,
        };
      },
    },
    hub: {
      taskChannel: (w, t) => `ws:${w}:task:${t}`,
      boardChannel: (w) => `ws:${w}:board`,
      publish: (channel, event) =>
        spies.published.push({ channel, event: event as Record<string, unknown> }),
    },
    registry: new AgentRegistry(),
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

/**
 * The Repository's setup-file allowlist, from the lifecycle's point of view (issue #52). What
 * gets copied is `setup-files.integration.test.ts`'s job; this asks the narrower question of
 * *when* the lifecycle asks for it, and what it subtracts afterwards.
 */
/**
 * The dependency gate on the resume path (issue #6 AC-3, hardening after review).
 *
 * `review.decide` refuses a `request_changes` that would start a blocked Task, but the
 * transition into `running` is applied by this lifecycle, and a guard at the API boundary holds
 * only for as long as the API is the sole producer of the `review.decided` event.
 */
describe("resuming a Task that has become blocked (issue #6)", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });
  beforeEach(() => {
    db = createTestDb();
  });

  /** A second Task in the same Workspace, in a state of the caller's choosing, to block against. */
  async function blockerFor(ids: Ids, state: "backlog" | "done"): Promise<string> {
    const [row] = await db.select().from(task).where(eq(task.id, ids.taskId)).limit(1);
    if (!row) throw new Error("task fixture missing");
    const blockerId = `blocker-${ids.taskId}`;
    await db.insert(task).values({
      id: blockerId,
      workspaceId: ids.workspaceId,
      issueId: row.issueId,
      title: "Blocker",
      state,
      agentProfileId: row.agentProfileId,
      executorProfileId: row.executorProfileId,
      repositoryId: row.repositoryId,
    });
    await db.insert(taskDependency).values({
      id: `dep-${ids.taskId}`,
      workspaceId: ids.workspaceId,
      taskId: ids.taskId,
      blockedByTaskId: blockerId,
    });
    return blockerId;
  }

  it("refuses to resume, with a reason, while a predecessor is outstanding", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    await blockerFor(ids, "backlog");
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep([{ decision: "request_changes", feedback: "again" }, "approve"]),
    });

    expect(result.result).toBe("blocked_by_dependency");
    expect(await taskState(db, ids.taskId)).toBe("failed");
    // The agent must not have been started a second time — a refused resume that still ran the
    // agent would be the gate reporting a refusal it did not actually apply.
    expect(runner.starts).toBe(1);
  });

  it("resumes normally once every predecessor is done", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    await blockerFor(ids, "done");
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep([{ decision: "request_changes", feedback: "again" }, "approve"]),
    });

    expect(result.result).toBe("done");
    expect(runner.starts).toBe(2);
  });

  it("does not consult the dependency graph of another Workspace (Principle V)", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const blockerId = await blockerFor(ids, "backlog");
    // Re-home the edge onto a Workspace this run knows nothing about: the blocker itself is
    // unchanged and still not done, so a query that forgot its tenant key would still refuse.
    await db
      .insert(workspace)
      .values({ id: `other-${ids.taskId}`, name: "Other", ownerUserId: "other" });
    await db
      .update(taskDependency)
      .set({ workspaceId: `other-${ids.taskId}` })
      .where(eq(taskDependency.blockedByTaskId, blockerId));
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep([{ decision: "request_changes", feedback: "again" }, "approve"]),
    });

    expect(result.result).toBe("done");
  });
});

describe("setup files copied into the agent's worktree (issue #52)", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });
  beforeEach(() => {
    db = createTestDb();
  });

  it("copies them into the worktree the agent reported, from the repository it prepared", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { setupFilePatterns: [".env", "config/local.json"] });
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(spies.seeded).toEqual([
      {
        repoPath: `/repo/${ids.taskId}`,
        worktreePath: `/wt/${worktreeNameForTask(ids.taskId)}`,
        patterns: [".env", "config/local.json"],
      },
    ]);
  });

  it("does not ask when the Repository configured no patterns", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(spies.seeded).toEqual([]);
  });

  it("copies once, on the round that creates the worktree — not on a resumed one", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { setupFilePatterns: [".env"] });
    const { deps, spies } = makeDeps(
      db,
      new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]),
      nullStream(),
    );

    // Round one creates the worktree; round two resumes inside it, where the files already are.
    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep([{ decision: "request_changes", feedback: "again" }, "approve"]),
    });

    expect(spies.seeded.length).toBe(1);
  });

  it("subtracts the patterns from every diff and commit (AC-4)", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { setupFilePatterns: [".env"] });
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // One diff capture at the review gate, one commit on approval — both told to leave the
    // copied files alone.
    expect(spies.excluded.length).toBe(2);
    for (const patterns of spies.excluded) expect(patterns).toEqual([".env"]);
  });

  it("logs counts and patterns, never a resolved path or a value (AC-3)", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { setupFilePatterns: [".env"] });
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _e, cb) {
        for (const line of chunk.toString().split("\n")) if (line.trim()) lines.push(line);
        cb();
      },
    });
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), stream);
    // A copy that partly failed is the only case that logs at all — and the warning must still
    // say nothing about which files were involved.
    deps.worktree.seed = async () => ({ copied: 1, unmatched: ["absent.env"], failed: 1 });

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const warning = lines.find((l) => l.includes("setup-files.incomplete"));
    expect(warning).toBeDefined();
    expect(warning).toContain("absent.env");
    // The worktree path is what a naive "copied X to Y" log line would carry.
    expect(warning).not.toContain(`/wt/${worktreeNameForTask(ids.taskId)}`);
  });
});

describe("the worktree a Task runs in", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });
  beforeEach(() => {
    db = createTestDb();
  });

  /** Records what each round was asked to do about its worktree. */
  class WorktreeRecordingRunner implements AgentRunner {
    readonly asked: Array<{ cwd: string; worktreeName: string | null }> = [];
    start(opts: AgentStartOpts): AgentHandle {
      this.asked.push({ cwd: opts.cwd, worktreeName: opts.worktreeName });
      opts.onEvent({ kind: "stdout", text: "working" });
      return {
        outcome: Promise.resolve<AgentOutcome>({ kind: "completed" }),
        workspacePath: Promise.resolve<string | null>(
          opts.worktreeName ? `/wt/${opts.worktreeName}` : opts.cwd,
        ),
        send: async () => true,
        stop: async () => {},
      };
    }
  }

  it("asks the agent to create one worktree, named after the Task", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new WorktreeRecordingRunner();
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // Run in the repository, and let `claude --worktree` make the directory. That is what
    // keeps concurrent Tasks on one repository apart (Principle II).
    expect(runner.asked).toEqual([
      { cwd: `/repo/${ids.taskId}`, worktreeName: `gatecontrol-task-${ids.taskId}` },
    ]);
  });

  it("continues in the same worktree when a reviewer asks for changes", async () => {
    // Asking for the worktree again would branch a fresh one from the base ref and throw away
    // everything the first round produced — the reviewer's feedback would be applied to nothing.
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new WorktreeRecordingRunner();
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep([{ decision: "request_changes", feedback: "add a test" }, "approve"]),
    });

    expect(runner.asked).toHaveLength(2);
    expect(runner.asked[1]).toEqual({
      cwd: `/wt/gatecontrol-task-${ids.taskId}`,
      worktreeName: null,
    });
  });

  it("fails the Task when the agent never reports a workspace", async () => {
    // No reported workspace means nothing confirmed the agent was isolated. Committing from
    // wherever it happened to be pointing would be worse than failing.
    const ids = freshIds();
    await seedRun(db, ids);
    const runner: AgentRunner = {
      start(opts: AgentStartOpts): AgentHandle {
        opts.onEvent({ kind: "stdout", text: "working" });
        return {
          outcome: Promise.resolve<AgentOutcome>({ kind: "completed" }),
          workspacePath: Promise.resolve<string | null>(null),
          send: async () => true,
          stop: async () => {},
        };
      },
    };
    const { deps } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("fail");
    expect(await taskState(db, ids.taskId)).toBe("failed");
  });

  it("cleans up the worktree the agent made, not one GateControl guessed at", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new WorktreeRecordingRunner();
    const { deps, spies } = makeDeps(db, runner, nullStream());
    const cleaned: string[] = [];

    await runTaskLifecycle(
      {
        ...deps,
        worktree: {
          ...deps.worktree,
          cleanup: async (_repo: string, path: string) => {
            cleaned.push(path);
          },
        },
      },
      { event: { data: ids }, step: scriptedStep(["approve"]) },
    );

    expect(cleaned).toEqual([`/wt/gatecontrol-task-${ids.taskId}`]);
    expect(spies.commit).toBe(1);
  });

  describe("agent catalog (issue #10)", () => {
    it("fails a Task whose Agent catalog protocol has no runner, rather than crashing inside one", async () => {
      const ids = freshIds();
      // `cli_passthrough` (#21) names a real member of AgentProtocol but has no driver behind
      // it yet — this must fail cleanly before an agent is ever started. (`acp` used to be the
      // subject of this case; issue #58 is the work that made it drivable.)
      await seedRun(db, ids, { agentProtocol: "cli_passthrough" });
      const runner = new ScriptedRunner([{ kind: "completed" }]);
      const { deps, spies } = makeDeps(db, runner, nullStream());

      const result = await runTaskLifecycle(deps, {
        event: { data: ids },
        step: scriptedStep(["approve"]),
      });

      expect(result.result).toBe("failed");
      expect(await taskState(db, ids.taskId)).toBe("failed");
      expect(runner.starts).toBe(0);
      expect(spies.commit).toBe(0);
      const [row] = await db.select().from(task).where(eq(task.id, ids.taskId)).limit(1);
      expect(row?.failureReason).toContain("cli_passthrough");
    });

    it("launches the agent with the command the catalog row declares, not a global env var", async () => {
      const ids = freshIds();
      await seedRun(db, ids);
      const runner = new ScriptedRunner([{ kind: "completed" }]);
      const { deps } = makeDeps(db, runner, nullStream());

      await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

      // seedRun's catalog row sets command "fake" — there is no GATECONTROL_AGENT_COMMAND any
      // more for this to have fallen back to.
      expect(runner.commands).toEqual(["fake"]);
    });

    it("strips the metered variable this catalog row names, not a hardcoded one", async () => {
      const ids = freshIds();
      await seedRun(db, ids);
      const runner = new ScriptedRunner([{ kind: "completed" }]);
      const { deps } = makeDeps(db, runner, nullStream());

      await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

      expect(runner.envs[0]?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-token");
      expect(runner.envs[0]).not.toHaveProperty("ANTHROPIC_API_KEY");
    });
  });
});

/**
 * The lifecycle over ACP (issue #58). What changes between the two protocols is exactly one
 * thing — who creates the worktree — and these pin that down along with the two consequences
 * that matter downstream: the same credential shaping applies, and a permission the agent asks
 * for reaches both the live stream and the durable session log.
 */
describe("a Task driven over ACP (issue #58)", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });

  beforeEach(() => {
    db = createTestDb();
  });

  it("runs instead of failing, now that a runner speaks the protocol", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp" });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("done");
    expect(runner.starts).toBe(1);
    expect(spies.commit).toBe(1);
  });

  it("provisions the worktree itself and asks the agent to make none", async () => {
    // An ACP agent has no `--worktree`: it works where it is told. The isolation guarantee is
    // unchanged (Principle II) — only who runs `git worktree add` moves.
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp" });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(spies.provisioned).toEqual([`/wt/gatecontrol-task-${ids.taskId}`]);
    expect(runner.worktreeNames).toEqual([null]);
    expect(runner.cwds).toEqual([`/wt/gatecontrol-task-${ids.taskId}`]);
  });

  it("leaves the Claude Code path creating its own worktree, exactly as before", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(spies.provisioned).toEqual([]);
    expect(runner.worktreeNames).toEqual([worktreeNameForTask(ids.taskId)]);
    expect(runner.cwds).toEqual([`/repo/${ids.taskId}`]);
  });

  it("still hands the agent only the credential the billing guard shaped (AC-5)", async () => {
    const ids = freshIds();
    await seedRun(db, ids, {
      agentProtocol: "acp",
      executorConfig: {
        kind: "local",
        env: { ANTHROPIC_API_KEY: "sk-metered" } as Record<string, string>,
      },
    });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(runner.envs[0]?.["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-token");
    expect(runner.envs[0]).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("publishes a permission request and writes it to the session log (AC-4)", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp" });
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        {
          kind: "permission_request",
          requestId: "req-1",
          title: "Write .env",
          toolKind: "edit",
          options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
        },
        {
          kind: "permission_resolved",
          requestId: "req-1",
          optionId: "allow",
          decidedBy: "operator",
        },
      ],
    );
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // Live, for the operator watching…
    expect(spies.published.map((p) => p.event["kind"])).toContain("permission_request");
    const published = spies.published.find((p) => p.event["kind"] === "permission_request");
    expect(published?.event).toMatchObject({ requestId: "req-1", title: "Write .env" });

    // …and durable, so a reconnect replays it rather than losing the question with the socket.
    const logged = await listTaskEventsSince(db, ids.workspaceId, ids.taskId, -1);
    expect(logged.map((e) => e.kind)).toContain("permission_request");
    expect(logged.map((e) => e.kind)).toContain("permission_resolved");
    const resolved = logged.find((e) => e.kind === "permission_resolved");
    expect(resolved?.payload).toMatchObject({ optionId: "allow", decidedBy: "operator" });
  });

  it("launches a second time after a rejected review, over the same worktree", async () => {
    // The branch and the directory are both named after the Task and nothing deletes the
    // branch, so a relaunch is where provisioning meets its own leftovers. The lifecycle must
    // reach a second run at all — the step used to throw before anything could be recorded.
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp" });
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    const rejected = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["reject"]),
    });
    expect(rejected.result).toBe("done");
    expect(await taskState(db, ids.taskId)).toBe("ready");

    const relaunched = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(relaunched.result).toBe("done");
    expect(runner.starts).toBe(2);
    // Both launches asked for the same worktree, and the second one committed.
    expect(spies.provisioned).toEqual([
      `/wt/gatecontrol-task-${ids.taskId}`,
      `/wt/gatecontrol-task-${ids.taskId}`,
    ]);
    expect(spies.commit).toBe(1);
  });

  it("fails the Task with a reason when its worktree cannot be provisioned", async () => {
    // The release-blocking shape of the old bug: the provisioning step threw outside any try,
    // so after Inngest burned its retries the Task sat in `running` forever with no
    // failureReason — the one outcome an operator can neither read nor act on.
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp" });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());
    deps.worktree.provision = async () => {
      throw new Error("fatal: a branch named 'gatecontrol/task-1' already exists");
    };

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("worktree_unavailable");
    expect(await taskState(db, ids.taskId)).toBe("failed");
    expect(await taskFailureReason(db, ids.taskId)).toContain("worktree");
    // No agent was started, and the board heard about the failure.
    expect(runner.starts).toBe(0);
    expect(spies.published.some((p) => p.event["state"] === "failed")).toBe(true);
  });

  it("keeps the git error out of the reason it shows the operator", async () => {
    // A failed clone or worktree command echoes back its own command line, and that command
    // line carries the credential-helper arguments for an imported repository (Principle IV).
    // The detail belongs in the log, not in a column the UI renders.
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp" });
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());
    deps.worktree.provision = async () => {
      throw new Error("command failed (128): git -c credential.helper=echo password=$TOKEN");
    };

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(await taskFailureReason(db, ids.taskId)).not.toContain("credential.helper");
  });
});
