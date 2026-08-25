/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import {
  type AgentPermissionMode,
  type AgentProtocol,
  type ExecutorConfig,
  TaskErrorCode,
  WIDGET_ANSWER_PREFIX,
} from "@gatecontrol/contracts";
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
  sessionSummary,
  task,
  taskDependency,
  taskRepository,
  workspace,
  worktree,
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
import { RepositoryUnusableError } from "../../worktree/manager.js";
import {
  runTaskLifecycle,
  type StepLike,
  type TaskRunDeps,
  widgetAnswerMessage,
} from "./task-run.js";

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

/** Attachment id for a Task's primary attachment, or for one of its extras. */
function attachmentId(taskId: string, key?: string): string {
  return key ? `attach-${taskId}-${key}` : `attach-${taskId}`;
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

/** A second Repository attached to the same Task, as a multi-repository fixture needs. */
interface ExtraRepository {
  /** Suffix for the repository and attachment ids, so two extras never collide. */
  key: string;
  name: string;
  setupFilePatterns?: string[];
  /** Defaults to the Task's derived branch, which is what the DAL would have written. */
  checkoutBranch?: string;
}

async function seedRun(
  db: TestDb,
  ids: Ids,
  opts: {
    agentProtocol?: AgentProtocol;
    executorConfig?: ExecutorConfig;
    setupFilePatterns?: string[];
    /**
     * A base ref on the *primary* attachment. Left unset by default, which is the ordinary case
     * and the one where a `--worktree` agent is still allowed to make its own worktree; a test
     * that wants GateControl to branch the primary itself names one.
     */
    baseRef?: string;
    /** A checkout branch on the primary; defaults to the name the DAL derives. */
    checkoutBranch?: string;
    /** Extra Repositories attached after the primary, in the order given (issue #7). */
    extraRepositories?: ExtraRepository[];
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
  await db.insert(issue).values({ id: issueId, workspaceId: ids.workspaceId, title: "Issue" });
  await db.insert(task).values({
    id: ids.taskId,
    workspaceId: ids.workspaceId,
    issueId,
    title: "Task",
    state: "running",
    agentProfileId: agentId,
    executorProfileId: executorId,
  });
  await db.insert(taskRepository).values({
    id: attachmentId(ids.taskId),
    workspaceId: ids.workspaceId,
    taskId: ids.taskId,
    repositoryId: repoId,
    baseRef: opts.baseRef ?? null,
    checkoutBranch: opts.checkoutBranch ?? `gatecontrol/task-${ids.taskId}`,
    position: 0,
  });
  for (const [index, extra] of (opts.extraRepositories ?? []).entries()) {
    const extraRepoId = `repo-${ids.taskId}-${extra.key}`;
    await db.insert(repository).values({
      id: extraRepoId,
      workspaceId: ids.workspaceId,
      name: extra.name,
      source: "local_path",
      location: `/srv/${ids.taskId}-${extra.key}`,
      ...(extra.setupFilePatterns ? { setupFilePatterns: extra.setupFilePatterns } : {}),
    });
    await db.insert(taskRepository).values({
      id: attachmentId(ids.taskId, extra.key),
      workspaceId: ids.workspaceId,
      taskId: ids.taskId,
      repositoryId: extraRepoId,
      baseRef: "main",
      checkoutBranch: extra.checkoutBranch ?? `gatecontrol/task-${ids.taskId}`,
      position: index + 1,
    });
  }
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

/**
 * A step runner that runs one step body twice, the way Inngest retries a step that threw after
 * doing part of its work. Distinct from a memoized replay, which is what the durable-step
 * machinery normally protects against and what `scriptedStep` models.
 */
function retryingStep(decisions: ScriptedDecision[], retryStepId: string): StepLike {
  const base = scriptedStep(decisions);
  const retried = new Set<string>();
  return {
    ...base,
    run: async (id, fn) => {
      if (id === retryStepId && !retried.has(id)) {
        retried.add(id);
        await fn();
      }
      return fn();
    },
  };
}

/** Fake agent runner returning queued outcomes; records how many times it started. */
class ScriptedRunner implements AgentRunner {
  starts = 0;
  /** How many times the lifecycle asked this run to stop — asserted by the abandon path. */
  stops = 0;
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
    private readonly events: AgentStreamEvent[] = [
      { kind: "stdout", channel: "assistant", text: "working" },
    ],
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
      stop: async () => {
        this.stops += 1;
      },
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
  /** What each of those was asked to branch, and from where (issue #7 AC-1). */
  provisionedFrom: Array<{ path: string; baseRef: string | null; checkoutBranch: string | null }>;
  /** The patterns each diff/commit was told to exclude — how AC-4 becomes observable. */
  excluded: string[][];
  /** Which worktree each plural operation acted on (issue #7): one entry per worktree. */
  committed: string[];
  discarded: string[];
  cleaned: string[];
  diffed: string[];
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
    provisionedFrom: [],
    excluded: [],
    committed: [],
    discarded: [],
    cleaned: [],
    diffed: [],
  };
  const deps: TaskRunDeps = {
    db,
    runner: () => runner,
    worktreeRoot: "/wt",
    repoCacheRoot: "/cache",
    logger: createLogger({ service: "orchestrator", destination: logStream }),
    worktree: {
      // Distinct per attachment, mirroring `worktreePath`: the primary keeps the Task's own
      // path so nothing about a single-Repository Task moves.
      prepare: async (p) =>
        p.attachmentId ? `/repo/${p.taskId}--${p.attachmentId}` : `/repo/${p.taskId}`,
      provision: async (p) => {
        const suffix = p.attachmentId ? `--${p.attachmentId}` : "";
        const path = `/wt/gatecontrol-task-${p.taskId}${suffix}`;
        spies.provisioned.push(path);
        spies.provisionedFrom.push({
          path,
          baseRef: p.baseRef ?? null,
          checkoutBranch: p.checkoutBranch ?? null,
        });
        return {
          path,
          branch: p.checkoutBranch ?? `gatecontrol/task-${p.taskId}`,
          repoPath: p.attachmentId ? `/repo/${p.taskId}--${p.attachmentId}` : `/repo/${p.taskId}`,
        };
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
      commit: async (path, _message, patterns) => {
        spies.commit += 1;
        spies.committed.push(path);
        spies.excluded.push(patterns);
      },
      discard: async (path) => {
        spies.discard += 1;
        spies.discarded.push(path);
      },
      cleanup: async (_repoPath, worktree) => {
        spies.cleanup += 1;
        spies.cleaned.push(worktree);
      },
      hasChanges: async () => true,
      diff: async (path, patterns) => {
        spies.diffed.push(path);
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

    // Filtered to the agent's own turns: the log also carries the diff captured at the review
    // gate and the state transitions the run announced.
    const logged = (
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, ids.sessionId))
    ).filter((e) => e.kind === "assistant_turn");
    expect(logged).toHaveLength(1);
    expect(logged[0]?.seq).toBe(0);
    // The record says what it is, rather than being a bare `{text}` a reader has to sniff (#2).
    expect(logged[0]?.payload).toEqual({
      kind: "assistant_turn",
      text: "working",
      thinking: false,
    });
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
    ).filter((e) => e.kind === "assistant_turn");
    // Round 0 writes seq 0; the agent-finished marker and the gate's captured diff follow, and
    // the resume records a transition — so round 1's turn lands at seq 4. One lower than it was:
    // the run no longer writes a `running → review` transition, because it no longer makes one.
    expect(logged.map((e) => e.seq)).toEqual([0, 4]);

    // Every event shares one `seq` sequence, diffs and transitions included, so a client
    // resuming from a cursor gets each of them exactly once and in order.
    const missed = await listTaskEventsSince(db, ids.workspaceId, ids.taskId, 0);
    expect(missed.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("announces Task state changes on the Workspace board channel", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const board = spies.published.filter((p) => p.channel === `ws:${ids.workspaceId}:board`);
    expect(board.map((p) => p.event["state"])).toEqual(["running", "done"]);
    // Task-scoped output never leaks onto the Workspace-wide board channel.
    expect(board.every((p) => p.event["kind"] === "status")).toBe(true);
  });

  it("announces a state change to the Task's own channel as well as the board", async () => {
    // The bug: it went to the board alone, so the Task page — the one place dedicated to this
    // very Task — kept saying the agent was writing until somebody reloaded. Every `diff` already
    // went to both; the status was the one that did not.
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const task = spies.published.filter(
      (p) =>
        p.channel === `ws:${ids.workspaceId}:task:${ids.taskId}` && p.event["kind"] === "status",
    );
    expect(task.map((p) => p.event["state"])).toEqual(["running", "done"]);
  });

  it("a Task's events are invisible to another Workspace's replay (Principle V)", async () => {
    const a = freshIds();
    const b = freshIds();
    await seedRun(db, a);
    await seedRun(db, b);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: a }, step: scriptedStep(["approve"]) });

    // One agent turn, the marker saying it finished, the diff captured at the gate, and the one
    // transition the run still records — `review → done` on approval. It no longer writes a
    // `running → review`, because entering review is the operator's move now.
    expect(await listTaskEventsSince(db, a.workspaceId, a.taskId, -1)).toHaveLength(4);
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

  /**
   * The typed log's own producers (issue #2). What is asserted is what each path *records*, not
   * what it publishes: the record is what a snapshot carries, what redaction reads, and what a
   * reviewer sees after the socket is gone.
   */
  it("records an assistant turn, a user turn and a notice from the channels the agent reported", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        { kind: "stdout", channel: "assistant", text: "patched latch.ts" },
        { kind: "stdout", channel: "thinking", text: "considering" },
        { kind: "stdout", channel: "user", text: "also add a test" },
        { kind: "stdout", channel: "system", text: "\nmode: plan\n" },
        {
          kind: "tool_use",
          name: "Edit",
          callId: "call-1",
          // Two arguments, one allowlisted for Edit and one that must never be stored.
          input: { file_path: "src/latch.ts", new_string: "SECRET FILE CONTENTS" },
          status: "in_progress",
        },
        { kind: "tool_result", callId: "call-1", ok: true, output: "applied" },
      ],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const logged = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId))
      .orderBy(asc(sessionEvent.seq));

    expect(logged.slice(0, 5).map((e) => e.payload)).toEqual([
      { kind: "assistant_turn", text: "patched latch.ts", thinking: false },
      { kind: "assistant_turn", text: "considering", thinking: true },
      { kind: "user_turn", text: "also add a test" },
      { kind: "notice", text: "\nmode: plan\n" },
      {
        kind: "tool_call",
        name: "Edit",
        callId: "call-1",
        // `new_string` is absent, and must stay absent: it is the file's contents.
        input: { file_path: "src/latch.ts" },
        status: "in_progress",
      },
    ]);
    expect(logged[5]?.payload).toEqual({
      kind: "tool_result",
      callId: "call-1",
      ok: true,
      output: "applied",
      truncated: false,
    });
    // The presentation marker is applied on the way to the wire and never stored, so what #16
    // and #84 read back is the agent's own text.
    expect(JSON.stringify(logged)).not.toContain("· considering");
  });

  it("records a TodoWrite as its list and drops the result that call would have folded into", async () => {
    // The plan replaces the call, so the call's `tool_result` has nothing left to fold into.
    // Logged anyway it reaches the transcript as an orphan and is drawn as a row named literally
    // "tool" carrying the CLI's "Todos have been modified successfully" — one per plan rewrite,
    // which is the contentless row this interception exists to remove, only anonymous.
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        {
          kind: "tool_use",
          name: "TodoWrite",
          callId: "toolu_todo",
          input: { todos: [{ content: "Write the patch", status: "in_progress" }] },
          status: "in_progress",
        },
        { kind: "tool_result", callId: "toolu_todo", ok: true, output: "Todos have been modified" },
        // A tool that was *not* intercepted still gets both halves, so this is a suppression of
        // one call's result and not of the branch.
        { kind: "tool_use", name: "Edit", callId: "call-1", input: {}, status: "in_progress" },
        { kind: "tool_result", callId: "call-1", ok: true, output: "applied" },
      ],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const payloads = (
      await db
        .select()
        .from(sessionEvent)
        .where(eq(sessionEvent.sessionId, ids.sessionId))
        .orderBy(asc(sessionEvent.seq))
    ).map((e) => e.payload as { kind: string; callId?: string | null });

    expect(payloads.filter((p) => p.kind === "todos")).toHaveLength(1);
    expect(payloads.filter((p) => p.kind === "tool_result").map((p) => p.callId)).toEqual([
      "call-1",
    ]);
  });

  it("writes the agent-finished marker before the step that moves the Task to review", async () => {
    /*
     * The ordering that decides whether a clean run can end up in the Failed column.
     *
     * Completion used to exist only as the run function's return value — real, in memory, and
     * recorded nowhere until `to-review` acted on it two steps later. Anything that lost the run
     * in between left no evidence the agent had ever finished, and the reclaim sweep, unable to
     * tell that from dying mid-work, filed it as a failure. The marker has to be in the log
     * *before* the transition, or it is not worth having.
     */
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const rows = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId))
      .orderBy(asc(sessionEvent.seq));
    const payloads = rows.map((e) => e.payload as { kind: string; to?: string; branch?: string });

    const doneAt = payloads.findIndex((p) => p.kind === "agent_done");
    const diffAt = payloads.findIndex((p) => p.kind === "diff");
    expect(doneAt).toBeGreaterThanOrEqual(0);
    // Strictly before the gate step's own work, which is the whole property: the marker is
    // written inside the step that learned the agent finished, not two steps later where a
    // restart could lose it.
    expect(doneAt).toBeLessThan(diffAt);
    // And it carries the branch, because that is what a sweep would need to finish the job.
    expect(payloads[doneAt]?.branch).toBeTruthy();
  });

  it("records a state transition once when a retried step body records it again", async () => {
    // Inngest retries a step *body* from the top when anything in it throws, and `to-review`
    // does three more things after recording the move. The seq comes from max+1, so the unique
    // index cannot dedupe the second write — a reviewer would read the Task as having entered
    // review twice.
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: retryingStep(["approve"], "to-review-0"),
    });

    const transitions = (
      await db
        .select()
        .from(sessionEvent)
        .where(eq(sessionEvent.sessionId, ids.sessionId))
        .orderBy(asc(sessionEvent.seq))
    )
      .filter((e) => e.kind === "state")
      .map((e) => e.payload);
    expect(transitions).toEqual([{ kind: "state", from: "review", to: "done" }]);
  });

  it("records a state event at each transition it announces", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const transitions = (
      await db
        .select()
        .from(sessionEvent)
        .where(eq(sessionEvent.sessionId, ids.sessionId))
        .orderBy(asc(sessionEvent.seq))
    )
      .filter((e) => e.kind === "state")
      .map((e) => e.payload);
    expect(transitions).toEqual([{ kind: "state", from: "review", to: "done" }]);
  });

  it("redacts a credential the agent printed instead of storing it in a payload (Principle IV)", async () => {
    // The log is the one record that outlives the run and travels — into a snapshot (#16), into
    // an agent's context (#84). A secret that reaches a payload is a secret that leaves with it,
    // and the realistic way one gets there is the agent echoing its own environment. So the
    // agent is scripted doing exactly that, in the two places a value can hide: a line of
    // output, and a tool name.
    const ids = freshIds();
    await seedRun(db, ids);
    const [stored] = await db
      .select({ ciphertext: secret.ciphertext })
      .from(secret)
      .where(eq(secret.id, `secret-${ids.taskId}`));
    const ciphertext = stored?.ciphertext ?? "unreachable";
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        { kind: "stdout", channel: "assistant", text: "$ echo $CLAUDE_CODE_OAUTH_TOKEN" },
        { kind: "stdout", channel: "assistant", text: "oauth-token\n" },
        { kind: "stdout", channel: "system", text: `secret at rest: ${ciphertext}` },
        {
          kind: "tool_use",
          name: "Bash(echo oauth-token)",
          callId: null,
          input: undefined,
          status: null,
        },
      ],
    );
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const rows = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId));
    const payloads = JSON.stringify(rows.map((e) => e.payload));
    expect(payloads).not.toContain("oauth-token");
    expect(payloads).not.toContain(ciphertext);
    // The line is kept, minus the value: a transcript with the sentence removed would hide from
    // a reviewer that the agent printed its token at all.
    expect(payloads).toContain("[redacted]");
    // The variable's *name* is not a secret, and redacting it would tell a reviewer less.
    expect(payloads).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    // The wire carries the same record, so an operator watching live sees no more than the log.
    expect(JSON.stringify(spies.published)).not.toContain("oauth-token");
  });

  it("keeps a record the payload union refuses instead of publishing it and dropping it", async () => {
    // The append validates (AC-1) and its failure is only reported, so a payload the union will
    // not admit used to be seen by every live client and by nobody who reconnects — losing an
    // outstanding permission request is the case that bites. A record the union cannot take is
    // coerced, not discarded, and the wire gets whatever the log got (AC-5).
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
          // The contract asks for a non-empty option id; the ACP wire schema does not.
          options: [{ optionId: "", name: "Allow", kind: "allow_once" }],
        },
      ],
    );
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const logged = await listTaskEventsSince(db, ids.workspaceId, ids.taskId, -1);
    const kept = logged.find((e) => JSON.stringify(e.payload).includes("Write .env"));
    if (!kept) throw new Error("the request was dropped from the log");
    // …and the frame the operator saw live names the same seq, so a reconnect replays the same
    // history rather than a shorter one.
    const seqs = spies.published
      .map((p) => p.event["seq"])
      .filter((seq): seq is number => typeof seq === "number");
    expect(seqs).toContain(kept.seq);
  });

  it("inserts a summary once the session is long enough, and deletes nothing (AC-2/AC-3)", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    // A round long enough to cross the compaction threshold. Anything shorter proves only that
    // the step ran, not that it did the thing.
    const chatter: AgentStreamEvent[] = Array.from({ length: 520 }, (_, i) => ({
      kind: "stdout" as const,
      channel: "assistant" as const,
      text: `line ${i}\n`,
    }));
    const { deps } = makeDeps(
      db,
      new ScriptedRunner([{ kind: "completed" }], chatter),
      nullStream(),
    );

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const summaries = await db
      .select()
      .from(sessionSummary)
      .where(eq(sessionSummary.sessionId, ids.sessionId));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.eventCount).toBeGreaterThan(0);
    // Every event the summary stands for is still there — a summary is an index into the log,
    // never a replacement for it (Principle I).
    const events = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId));
    expect(events.length).toBeGreaterThanOrEqual(520);
    const covered = events.filter(
      (e) => e.seq >= (summaries[0]?.fromSeq ?? 0) && e.seq <= (summaries[0]?.toSeq ?? 0),
    );
    expect(covered).toHaveLength(summaries[0]?.eventCount ?? -1);
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

  it("tells the agent the round is a redo even when the reviewer wrote nothing", async () => {
    // The review gate no longer collects feedback, so this is now the ordinary shape of a
    // Request changes. Each round is a fresh process with no memory of the last, so a brief
    // identical to round one's hands the agent the original instructions in a worktree that
    // already holds its own rejected work, with nothing anywhere saying it was turned down.
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["request_changes", "approve"]),
    });

    expect(runner.prompts[0]).not.toContain("not accepted");
    expect(runner.prompts[1]).toContain("Your previous attempt was not accepted.");
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
        opts.onEvent({ kind: "stdout", channel: "assistant", text: "working" });
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

/** One completed turn, which is what the mid-run diff capture keys off. */
function usageEvent(messageId: string): AgentStreamEvent {
  return {
    kind: "usage",
    messageId,
    reported: true,
    model: "claude-test",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

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

  it("is captured at a turn boundary too, so a live run can be watched", async () => {
    // The reason this exists: an agent that finishes a turn by asking "shall I commit this?"
    // has real work in its worktree and, with only the gate capturing, nothing in the log for
    // the Changes panel to render. The operator answered blind.
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [{ kind: "stdout", channel: "assistant", text: "edited it" }, usageEvent("msg-1")],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const events = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId))
      .orderBy(asc(sessionEvent.seq));
    const firstDiff = events.find((e) => e.kind === "diff");
    const finished = events.find((e) => e.kind === "agent_done");
    expect(firstDiff?.payload).toMatchObject({
      diffRef: `gatecontrol-task-${ids.taskId}`,
      files: [{ path: "src/latch.ts", status: "modified", additions: 4, deletions: 1 }],
    });
    // Before the marker that says the agent finished — which is the whole point: the record
    // existed while the run was still open.
    expect(finished).toBeDefined();
    expect(firstDiff?.seq).toBeLessThan(finished?.seq ?? -1);
  });

  it("writes nothing for a turn that changed nothing since the last one", async () => {
    // A long run is mostly turns that read. Capturing each one would fill the log with copies
    // of a patch the panel already has.
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [usageEvent("msg-1"), usageEvent("msg-2"), usageEvent("msg-3")],
    );
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const stored = (
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, ids.sessionId))
    ).filter((e) => e.kind === "diff");
    // Two turn captures — the first, and one trailing re-run coalescing the turns that landed
    // while it was working — plus the gate's. All three asked git; only the first and the
    // gate's wrote anything, because the patch never changed.
    expect(spies.diffed).toHaveLength(3);
    expect(stored).toHaveLength(2);
  });

  it("a mid-run capture failure neither fails the run nor stops the gate capturing", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }], [usageEvent("msg-1")]);
    const { deps } = makeDeps(db, runner, nullStream());
    let calls = 0;
    const flaky: TaskRunDeps = {
      ...deps,
      worktree: {
        ...deps.worktree,
        diff: async (path, patterns) => {
          calls += 1;
          if (calls === 1) throw new Error("git exploded mid-turn");
          return deps.worktree.diff(path, patterns);
        },
      },
    };

    const result = await runTaskLifecycle(flaky, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("done");
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
    });
    await db.insert(taskRepository).values({
      id: `attach-blocker-${ids.taskId}`,
      workspaceId: ids.workspaceId,
      taskId: blockerId,
      repositoryId: `repo-${ids.taskId}`,
      checkoutBranch: `gatecontrol/task-${blockerId}`,
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
      opts.onEvent({ kind: "stdout", channel: "assistant", text: "working" });
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

  /**
   * The row, not the directory.
   *
   * `worktree` was read in two places — the delete preview and the Issue view, both asking "does
   * this Task still hold a working copy" — and written in none, so both got `no` for every Task
   * whatever was on disk. Only the tests ever inserted a row, which is why nothing caught it.
   */
  describe("the row that says the directory exists", () => {
    it("is written for the worktree the agent made and GateControl adopted", async () => {
      const ids = freshIds();
      await seedRun(db, ids);
      // A hard failure preserves the worktree, so the row can be observed still active.
      const { deps } = makeDeps(
        db,
        new ScriptedRunner([{ kind: "failed", signal: {} }]),
        nullStream(),
      );

      await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep([]) });

      const rows = await db.select().from(worktree).where(eq(worktree.taskId, ids.taskId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        path: `/wt/${worktreeNameForTask(ids.taskId)}`,
        branch: worktreeNameForTask(ids.taskId),
        status: "active",
      });
    });

    it("is written for a worktree GateControl provisioned itself", async () => {
      const ids = freshIds();
      await seedRun(db, ids, { agentProtocol: "acp" });
      const { deps } = makeDeps(
        db,
        new ScriptedRunner([{ kind: "failed", signal: {} }]),
        nullStream(),
      );

      await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep([]) });

      const rows = await db.select().from(worktree).where(eq(worktree.taskId, ids.taskId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("active");
    });

    it("is marked removed once the directory has actually been cleaned up", async () => {
      const ids = freshIds();
      await seedRun(db, ids);
      const { deps, spies } = makeDeps(
        db,
        new ScriptedRunner([{ kind: "completed" }]),
        nullStream(),
      );

      await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

      expect(spies.cleanup).toBe(1);
      const rows = await db.select().from(worktree).where(eq(worktree.taskId, ids.taskId));
      // Kept rather than deleted: a Task whose worktree was cleaned up is a different fact from
      // one that never had a worktree, and the path is the only record of where the work ran.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("removed");
    });

    it("does not double a row when the round that adopts it runs twice", async () => {
      const ids = freshIds();
      await seedRun(db, ids);
      const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

      await runTaskLifecycle(deps, {
        event: { data: ids },
        step: retryingStep(["approve"], "record-worktree-0"),
      });

      const rows = await db.select().from(worktree).where(eq(worktree.taskId, ids.taskId));
      expect(rows).toHaveLength(1);
    });
  });

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
        opts.onEvent({ kind: "stdout", channel: "assistant", text: "working" });
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
    expect(logged.map((e) => e.payload.kind)).toContain("permission_request");
    expect(logged.map((e) => e.payload.kind)).toContain("permission_resolved");
    const resolved = logged.find((e) => e.payload.kind === "permission_resolved");
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

/**
 * Multi-repository Tasks (issue #7). What changes between one Repository and several is plural
 * iteration — provisioning, diff capture, commit, discard, cleanup — plus one thing that does
 * *not* go plural and is stated here rather than assumed: the agent runs in exactly one working
 * directory, and the others are named to it in the brief.
 */
describe("a Task spanning several Repositories (issue #7)", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });
  beforeEach(() => {
    db = createTestDb();
  });

  const twoRepositories = { extraRepositories: [{ key: "lib", name: "shared-lib" }] };

  it("AC-2: provisions one isolated worktree per attached (repository, branch) pair", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp", ...twoRepositories });
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // Two worktrees, two distinct paths. The primary's is byte-identical to what a
    // single-Repository Task gets, so nothing about the existing shape moved.
    expect(spies.provisioned).toEqual([
      `/wt/gatecontrol-task-${ids.taskId}`,
      `/wt/gatecontrol-task-${ids.taskId}--${attachmentId(ids.taskId, "lib")}`,
    ]);
    expect(new Set(spies.provisioned).size).toBe(2);
  });

  it("AC-2: still lets the Claude Code agent make its own primary, and makes the rest itself", async () => {
    const ids = freshIds();
    await seedRun(db, ids, twoRepositories);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // Only the secondary is provisioned by GateControl; the agent is still asked for its own.
    expect(spies.provisioned).toEqual([
      `/wt/gatecontrol-task-${ids.taskId}--${attachmentId(ids.taskId, "lib")}`,
    ]);
    expect(runner.worktreeNames).toEqual([worktreeNameForTask(ids.taskId)]);
  });

  it("AC-3: fails the Task naming the Repository it could not prepare, before any agent starts", async () => {
    const ids = freshIds();
    await seedRun(db, ids, twoRepositories);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());
    deps.worktree.prepare = async (p) => {
      // The kind of failure no retry can fix, which is what makes it answerable now.
      if (p.repository.location.endsWith("-lib")) {
        throw new RepositoryUnusableError("not a git repository");
      }
      return `/repo/${p.taskId}`;
    };

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("repository_unreachable");
    expect(await taskState(db, ids.taskId)).toBe("failed");
    expect(await taskFailureReason(db, ids.taskId)).toBe(
      `${TaskErrorCode.RepositoryUnreachable}: shared-lib`,
    );
    // The whole point of AC-3: nothing was started, so there is no half-done work to reconcile.
    expect(runner.starts).toBe(0);
    expect(spies.commit).toBe(0);
    expect(spies.published.some((p) => p.event["state"] === "failed")).toBe(true);
  });

  it("AC-3: keeps the git error out of the reason, even while naming the repository", async () => {
    // A failed clone echoes back the credential-helper argument list (Principle IV).
    const ids = freshIds();
    await seedRun(db, ids, twoRepositories);
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());
    deps.worktree.prepare = async () => {
      throw new Error("command failed (128): git -c credential.helper=echo password=$TOKEN");
    };

    // On the last attempt, where a clone failure stops being something worth waiting on.
    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
      attempt: 2,
    });

    expect(await taskFailureReason(db, ids.taskId)).not.toContain("credential.helper");
  });

  it("AC-1: branches the primary itself when its attachment names a base ref", async () => {
    // `claude --worktree` branches from HEAD and names the branch itself, so an attachment that
    // asks for anything else cannot be handed to it. Before this, the Owner's base ref was
    // stored, shown in the brief and silently dropped — while the *secondary* attachments of the
    // same Task honoured theirs.
    const ids = freshIds();
    await seedRun(db, ids, { baseRef: "release/2.1" });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(spies.provisionedFrom).toEqual([
      {
        path: `/wt/gatecontrol-task-${ids.taskId}`,
        baseRef: "release/2.1",
        checkoutBranch: `gatecontrol/task-${ids.taskId}`,
      },
    ]);
    // The agent is started inside the worktree GateControl made, and asked for none of its own.
    expect(runner.cwds).toEqual([`/wt/gatecontrol-task-${ids.taskId}`]);
    expect(runner.worktreeNames).toEqual([null]);
  });

  it("AC-1: branches the primary itself when its attachment names a checkout branch", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { checkoutBranch: "release/2.1-fix" });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(spies.provisionedFrom).toEqual([
      {
        path: `/wt/gatecontrol-task-${ids.taskId}`,
        baseRef: null,
        checkoutBranch: "release/2.1-fix",
      },
    ]);
    expect(runner.worktreeNames).toEqual([null]);
  });

  it("names in the brief the branch the agent is on, not the one the attachment stores", async () => {
    // The brief is the *only* mechanism by which a multi-repository agent learns its layout, so
    // a branch line it cannot act on is worse than none. A `--worktree` agent names its own
    // branch (`gatecontrol-task-<id>`), which the attachment's `gatecontrol/task-<id>` is not.
    const ids = freshIds();
    await seedRun(db, ids, {
      extraRepositories: [{ key: "lib", name: "shared-lib", checkoutBranch: "feature/lib" }],
    });
    const runner = new ScriptedRunner([{ kind: "completed" }, { kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep([{ decision: "request_changes", feedback: "again" }, "approve"]),
    });

    // Round one: nothing has asked git yet, so the primary line carries no branch at all.
    expect(runner.prompts[0]).toContain("- repo — you are working here");
    expect(runner.prompts[0]).not.toContain(`gatecontrol/task-${ids.taskId}`);
    // Round two: the worktree has been adopted, so the brief can name what git reported.
    expect(runner.prompts[1]).toContain(
      `- repo (branch gatecontrol-task-${ids.taskId}) — you are working here`,
    );
    // The secondary's branch is GateControl's own, and is named from the first round.
    expect(runner.prompts[0]).toContain("- shared-lib (branch feature/lib)");
  });

  it("removes the worktrees it already created when a later one cannot be provisioned", async () => {
    // The run returns before the lifecycle's own cleanup is reachable, and nothing outside the
    // provisioning loop ever learns those directories exist — so a three-repository Task whose
    // third repository is unreachable used to leave two worktrees and two checked-out branches
    // behind, blocking the next launch from reusing them.
    const ids = freshIds();
    await seedRun(db, ids, {
      agentProtocol: "acp",
      extraRepositories: [
        { key: "lib", name: "shared-lib" },
        { key: "docs", name: "docs" },
      ],
    });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps, spies } = makeDeps(db, runner, nullStream());
    const provision = deps.worktree.provision;
    deps.worktree.provision = async (params) => {
      if (params.attachmentId === attachmentId(ids.taskId, "docs")) {
        throw new Error("fatal: could not create worktree");
      }
      return provision(params);
    };

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("worktree_unavailable");
    expect(spies.cleaned).toEqual([
      `/wt/gatecontrol-task-${ids.taskId}`,
      `/wt/gatecontrol-task-${ids.taskId}--${attachmentId(ids.taskId, "lib")}`,
    ]);
  });

  it("AC-3: retries a prepare failure a retry could fix, rather than burying the Task on the first flake", async () => {
    // `task-run` is declared with retries, and wrapping this step in a catch had quietly spent
    // them: one clone timeout failed the Task permanently on attempt zero (Principle III).
    const ids = freshIds();
    await seedRun(db, ids, twoRepositories);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());
    deps.worktree.prepare = async () => {
      throw new Error("fatal: unable to access remote: could not resolve host");
    };

    await expect(
      runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) }),
    ).rejects.toThrow("could not resolve host");

    // Left for Inngest to retry: not failed, and no reason written that a later attempt would
    // have to un-say.
    expect(await taskState(db, ids.taskId)).toBe("running");
    expect(await taskFailureReason(db, ids.taskId)).toBe("");
    expect(runner.starts).toBe(0);
  });

  it("AC-3: names the Repository once the retries are gone", async () => {
    const ids = freshIds();
    await seedRun(db, ids, twoRepositories);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());
    deps.worktree.prepare = async () => {
      throw new Error("fatal: unable to access remote: could not resolve host");
    };

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
      attempt: 2,
    });

    // AC-3 asks the Task to fail with a name, which is exactly what the last attempt does.
    expect(result.result).toBe("repository_unreachable");
    expect(await taskFailureReason(db, ids.taskId)).toBe(
      `${TaskErrorCode.RepositoryUnreachable}: repo`,
    );
    expect(runner.starts).toBe(0);
  });

  it("AC-3: names the Repository whose worktree could not be created", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp", ...twoRepositories });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());
    deps.worktree.provision = async (p) => {
      if (p.attachmentId) throw new Error("fatal: branch already checked out");
      return {
        path: `/wt/gatecontrol-task-${p.taskId}`,
        branch: `gatecontrol/task-${p.taskId}`,
        repoPath: `/repo/${p.taskId}`,
      };
    };

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("worktree_unavailable");
    expect(await taskFailureReason(db, ids.taskId)).toContain("shared-lib");
    expect(runner.starts).toBe(0);
  });

  it("AC-4: writes one diff event per Repository, each naming the repository it belongs to", async () => {
    const ids = freshIds();
    await seedRun(db, ids, {
      agentProtocol: "acp",
      extraRepositories: [
        { key: "lib", name: "shared-lib", checkoutBranch: `gatecontrol/lib-only` },
      ],
    });
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const diffs = (
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, ids.sessionId))
    )
      .filter((e) => e.kind === "diff")
      .map((e) => e.payload as { repositoryId: string; repositoryName: string; diffRef: string });
    expect(diffs).toHaveLength(2);
    expect(diffs.map((d) => d.repositoryName)).toEqual(["repo", "shared-lib"]);
    expect(new Set(diffs.map((d) => d.repositoryId)).size).toBe(2);
    // Each group names the branch its own worktree sits on, not one branch for the whole Task.
    expect(diffs.map((d) => d.diffRef)).toEqual([
      `gatecontrol-task-${ids.taskId}`,
      "gatecontrol/lib-only",
    ]);
    // Each worktree was diffed once — a reviewer sees both changes, not the primary's twice.
    expect(new Set(spies.diffed).size).toBe(2);
  });

  it("AC-4: one repository failing to capture costs only its own group", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp", ...twoRepositories });
    const { deps } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());
    const realDiff = deps.worktree.diff;
    deps.worktree.diff = async (path, patterns) => {
      if (path.includes("--")) throw new Error("git exploded");
      return realDiff(path, patterns);
    };

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    expect(result.result).toBe("done");
    const diffs = (
      await db.select().from(sessionEvent).where(eq(sessionEvent.sessionId, ids.sessionId))
    ).filter((e) => e.kind === "diff");
    expect(diffs).toHaveLength(1);
  });

  it("AC-4: approve commits every worktree and records each attachment's result branch", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp", ...twoRepositories });
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(spies.commit).toBe(2);
    expect(new Set(spies.committed).size).toBe(2);
    const attachments = await db
      .select()
      .from(taskRepository)
      .where(eq(taskRepository.taskId, ids.taskId))
      .orderBy(asc(taskRepository.position));
    // A single column on `task` could only ever have named one of these branches. The primary's
    // is the branch the adoption check read back from git; the secondary's is the branch
    // GateControl checked its worktree out on.
    expect(attachments.map((a) => a.resultBranch)).toEqual([
      `gatecontrol-task-${ids.taskId}`,
      `gatecontrol/task-${ids.taskId}`,
    ]);
  });

  it("AC-4: reject discards every worktree, and cleanup removes every worktree", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp", ...twoRepositories });
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["reject"]) });

    // A secondary left with uncommitted work — or with its branch still checked out — would
    // meet the next launch as a conflict nothing knows how to explain.
    expect(new Set(spies.discarded).size).toBe(2);
    expect(new Set(spies.cleaned).size).toBe(2);
  });

  it("copies each Repository's own setup files into its own worktree (issue #52)", async () => {
    const ids = freshIds();
    await seedRun(db, ids, {
      agentProtocol: "acp",
      setupFilePatterns: [".env"],
      extraRepositories: [
        { key: "lib", name: "shared-lib", setupFilePatterns: ["config/local.json"] },
      ],
    });
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // Each worktree gets its *own* repository's allowlist — not the primary's applied twice.
    const seededByPatterns = Object.fromEntries(
      spies.seeded.map((s) => [s.patterns.join(","), s.worktreePath]),
    );
    expect(Object.keys(seededByPatterns).sort()).toEqual([".env", "config/local.json"]);
    expect(seededByPatterns[".env"]).not.toBe(seededByPatterns["config/local.json"]);
  });

  it("the stated limitation: the agent runs in the primary worktree and is told where the others are", async () => {
    // This is the one thing that does not go plural. An agent process gets one `cwd`, so the
    // only way it can reach a second repository is by being told the absolute path — which is
    // why this is a test with a name rather than an assumption behind an index.
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp", ...twoRepositories });
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const secondary = `/wt/gatecontrol-task-${ids.taskId}--${attachmentId(ids.taskId, "lib")}`;
    expect(runner.cwds).toEqual([`/wt/gatecontrol-task-${ids.taskId}`]);
    expect(runner.prompts[0]).toContain("# Repositories");
    expect(runner.prompts[0]).toContain("shared-lib");
    expect(runner.prompts[0]).toContain(secondary);
  });

  it("says nothing about repositories in a single-Repository Task's brief", async () => {
    // The brief an existing Task gets is unchanged by this refactor.
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    expect(runner.prompts[0]).not.toContain("# Repositories");
  });

  it("starts the agent in the position-0 attachment, whatever order the rows were written in", async () => {
    const ids = freshIds();
    await seedRun(db, ids, { agentProtocol: "acp", ...twoRepositories });
    // Swap the positions, via a spare slot: `(task_id, position)` is unique precisely so that
    // two attachments can never both claim to be primary.
    await db
      .update(taskRepository)
      .set({ position: 2 })
      .where(eq(taskRepository.id, attachmentId(ids.taskId)));
    await db
      .update(taskRepository)
      .set({ position: 0 })
      .where(eq(taskRepository.id, attachmentId(ids.taskId, "lib")));
    await db
      .update(taskRepository)
      .set({ position: 1 })
      .where(eq(taskRepository.id, attachmentId(ids.taskId)));
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // The new primary keeps the Task's own path; the demoted one becomes the sibling.
    expect(runner.cwds).toEqual([`/wt/gatecontrol-task-${ids.taskId}`]);
    expect(runner.prompts[0]).toContain(
      `/wt/gatecontrol-task-${ids.taskId}--${attachmentId(ids.taskId)}`,
    );
  });

  it("AC-5: no two worktrees of one Task, or of two Tasks, share a path", async () => {
    const a = freshIds();
    const b = freshIds();
    await seedRun(db, a, { agentProtocol: "acp", ...twoRepositories });
    await seedRun(db, b, { agentProtocol: "acp", ...twoRepositories });
    const depsA = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());
    const depsB = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());

    await Promise.all([
      runTaskLifecycle(depsA.deps, { event: { data: a }, step: scriptedStep(["approve"]) }),
      runTaskLifecycle(depsB.deps, { event: { data: b }, step: scriptedStep(["approve"]) }),
    ]);

    const all = [...depsA.spies.provisioned, ...depsB.spies.provisioned];
    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(4);
  });
});

/**
 * Approving a Task whose agent only touched some of its Repositories (issue #7).
 *
 * This is the ordinary case, not an exotic one: the agent runs in exactly one working
 * directory, so a Task spanning three repositories routinely reaches the gate having changed
 * one of them.
 */
describe("approving a multi-Repository Task that changed only some of them", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });
  beforeEach(() => {
    db = createTestDb();
  });

  it("commits only the worktrees that changed, and still records every branch", async () => {
    const ids = freshIds();
    await seedRun(db, ids, {
      agentProtocol: "acp",
      extraRepositories: [{ key: "lib", name: "shared-lib" }],
    });
    const { deps, spies } = makeDeps(db, new ScriptedRunner([{ kind: "completed" }]), nullStream());
    // The agent worked in the primary and never went near the secondary.
    deps.worktree.hasChanges = async (path) => !path.includes("--");

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    // `git commit` with nothing staged exits non-zero; committing the untouched worktree anyway
    // would fail the whole approve step, including for the repository that *did* change.
    expect(result.result).toBe("done");
    expect(await taskState(db, ids.taskId)).toBe("done");
    expect(spies.commit).toBe(1);
    expect(spies.committed[0]).toBe(`/wt/gatecontrol-task-${ids.taskId}`);

    // Both branches are still recorded: the secondary's exists and is what a reviewer fetches.
    const attachments = await db
      .select()
      .from(taskRepository)
      .where(eq(taskRepository.taskId, ids.taskId))
      .orderBy(asc(taskRepository.position));
    expect(attachments.every((a) => a.resultBranch !== null)).toBe(true);
  });
});

/**
 * Agent widgets (`ff-agent-widgets`): the run teaches the agent the fence, lifts what it emits
 * out of the prose, and records it as its own event — so a client can draw the thing rather than
 * printing the JSON that described it.
 */
describe("task-run permission mode", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("builds the runner with the Agent Profile's own permission mode", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    await db
      .update(agentProfile)
      .set({ permissionMode: "bypassPermissions" })
      .where(eq(agentProfile.id, (await seededProfileId(db, ids)) ?? ""));

    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());
    const asked: Array<string | undefined> = [];
    const wrapped = {
      ...deps,
      runner: (protocol: AgentProtocol, mode: AgentPermissionMode) => {
        asked.push(mode);
        return deps.runner(protocol, mode);
      },
    };

    await runTaskLifecycle(wrapped, { event: { data: ids }, step: scriptedStep(["approve"]) });

    // The posture is read off the Profile the Task names, not off a process-wide default: this
    // is what lets one Workspace hold a "never asks" Profile beside a cautious one.
    expect(asked).toEqual(["bypassPermissions"]);
  });

  it("leaves a Profile that never chose one on the cautious default", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());
    const asked: Array<string | undefined> = [];
    const wrapped = {
      ...deps,
      runner: (protocol: AgentProtocol, mode: AgentPermissionMode) => {
        asked.push(mode);
        return deps.runner(protocol, mode);
      },
    };

    await runTaskLifecycle(wrapped, { event: { data: ids }, step: scriptedStep(["approve"]) });
    expect(asked).toEqual(["acceptEdits"]);
  });
});

/** The Agent Profile `seedRun` created for this run. */
async function seededProfileId(db: TestDb, ids: { taskId: string }): Promise<string | undefined> {
  const [row] = await db
    .select({ id: task.agentProfileId })
    .from(task)
    .where(eq(task.id, ids.taskId))
    .limit(1);
  return row?.id;
}

describe("task-run widgets", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  const ASK =
    '{"kind":"ask_user_input","prompt":"Which database?","options":[{"id":"pg","label":"PostgreSQL"}]}';

  async function enableWidgets(ids: ReturnType<typeof freshIds>): Promise<void> {
    await db
      .update(workspace)
      .set({ enabledFlags: { "ff-agent-widgets": true } })
      .where(eq(workspace.id, ids.workspaceId));
  }

  it("records what the agent said about stopping, when it said anything", async () => {
    // Without a `task_complete` the marker still gets written — the fix must not depend on an
    // agent knowing GateControl exists — so this is about the enrichment, not the mechanism.
    const ids = freshIds();
    await seedRun(db, ids);
    await enableWidgets(ids);
    const report = '{"kind":"task_complete","outcome":"nothing_to_do","summary":"Already pinned."}';
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        {
          kind: "stdout",
          channel: "assistant",
          text: `Nothing needed.\n\`\`\`gatecontrol:widget\n${report}\n\`\`\``,
        },
      ],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const payloads = (
      await db
        .select()
        .from(sessionEvent)
        .where(eq(sessionEvent.sessionId, ids.sessionId))
        .orderBy(asc(sessionEvent.seq))
    ).map((e) => e.payload as { kind: string; outcome?: string; summary?: string });

    const marker = payloads.find((p) => p.kind === "agent_done");
    expect(marker?.outcome).toBe("nothing_to_do");
    expect(marker?.summary).toBe("Already pinned.");
  });

  it("records a fenced emission as a widget event and keeps it out of the prose", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    await enableWidgets(ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        {
          kind: "stdout",
          channel: "assistant",
          text: `Picking a store.\n\`\`\`gatecontrol:widget\n${ASK}\n\`\`\`\nStanding by.`,
        },
      ],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const logged = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId))
      .orderBy(asc(sessionEvent.seq));

    const widgets = logged.filter((e) => e.kind === "widget");
    expect(widgets).toHaveLength(1);
    expect(widgets[0]?.payload).toMatchObject({
      kind: "widget",
      widget: { kind: "ask_user_input", prompt: "Which database?" },
    });

    // The prose keeps its sentences and loses the block — an operator reading the transcript
    // must never see the JSON that produced the widget beside the widget itself.
    const prose = logged
      .filter((e) => e.kind === "assistant_turn")
      .map((e) => (e.payload as { text: string }).text)
      .join("");
    expect(prose).toBe("Picking a store.\nStanding by.");
    expect(prose).not.toContain("ask_user_input");
  });

  it("teaches the fence in the brief, and only when the flag is on", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    await enableWidgets(ids);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());
    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });
    expect(runner.prompts[0]).toContain("gatecontrol:widget");

    const off = freshIds();
    await seedRun(db, off);
    const quiet = new ScriptedRunner([{ kind: "completed" }]);
    const { deps: offDeps } = makeDeps(db, quiet, nullStream());
    await runTaskLifecycle(offDeps, { event: { data: off }, step: scriptedStep(["approve"]) });
    // A Workspace without the flag gets the brief it always got, byte for byte.
    expect(quiet.prompts[0]).not.toContain("gatecontrol:widget");
  });

  it("leaves the output untouched for a Workspace with the flag off", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        {
          kind: "stdout",
          channel: "assistant",
          text: `\`\`\`gatecontrol:widget\n${ASK}\n\`\`\``,
        },
      ],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const logged = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId));
    expect(logged.filter((e) => e.kind === "widget")).toHaveLength(0);
    // Not parsed, not stripped: with the feature off the block is exactly what it looks like.
    const prose = logged
      .filter((e) => e.kind === "assistant_turn")
      .map((e) => (e.payload as { text: string }).text)
      .join("");
    expect(prose).toContain("gatecontrol:widget");
  });

  it("does not read a widget out of the model's reasoning", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    await enableWidgets(ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        {
          kind: "stdout",
          channel: "thinking",
          text: `maybe \`\`\`gatecontrol:widget\n${ASK}\n\`\`\``,
        },
      ],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const logged = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId));
    // Thinking about a widget is not asking for one.
    expect(logged.filter((e) => e.kind === "widget")).toHaveLength(0);
  });
});

/**
 * A Task deleted while its agent is still streaming (observed in a dev run: one
 * `FOREIGN KEY constraint failed` per chunk of output, at `session-event-append`).
 *
 * Cancellation happens between Inngest steps and stopping an agent is a request rather than an
 * instant, so this window is real by design. What is not acceptable is what the window used to
 * cost: a stack trace per event, an agent left running for a review nobody will ever hold, and a
 * round that carries on writing to rows that are gone.
 */
describe("task-run when its Session is deleted mid-run", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("stops the agent and abandons the round instead of failing per event", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    // Exactly what `cascadeDeleteTasks` does when the Task is force-deleted underneath the run.
    await db.delete(session).where(eq(session.id, ids.sessionId));

    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [
        { kind: "stdout", channel: "assistant", text: "still working" },
        { kind: "stdout", channel: "assistant", text: "and still going" },
      ],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    // The run ends by saying what happened, rather than throwing its way through the review gate.
    expect(result).toEqual({ taskId: ids.taskId, result: "abandoned" });
    // And the agent is not left burning tokens for a Task that no longer exists.
    expect(runner.stops).toBe(1);

    // Nothing was written, because there was nowhere to write it.
    const events = await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, ids.sessionId));
    expect(events).toHaveLength(0);
  });

  it("leaves an ordinary run untouched", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    const runner = new ScriptedRunner([{ kind: "completed" }]);
    const { deps } = makeDeps(db, runner, nullStream());

    const result = await runTaskLifecycle(deps, {
      event: { data: ids },
      step: scriptedStep(["approve"]),
    });

    // The latch is only ever tripped by a missing parent row: a healthy run still reviews,
    // still records, and never stops its own agent early.
    expect(result.result).not.toBe("abandoned");
    expect(runner.stops).toBe(0);
  });
});

describe("widgetAnswerMessage", () => {
  const ask = {
    kind: "ask_user_input" as const,
    prompt: "Which database?",
    mode: "single" as const,
    allowOther: false,
    options: [
      { id: "pg", label: "PostgreSQL" },
      { id: "sqlite", label: "SQLite" },
    ],
  };

  it("leads with the marker the transcript filters on", () => {
    const message = widgetAnswerMessage(ask, { widgetId: "w-1", values: ["sqlite"], text: null });
    expect(message.startsWith(WIDGET_ANSWER_PREFIX)).toBe(true);
  });

  it("says the labels the agent wrote, and the ids it defined", () => {
    const message = widgetAnswerMessage(ask, { widgetId: "w-1", values: ["sqlite"], text: null });
    expect(message).toContain("SQLite");
    expect(message).toContain("ids: sqlite");
    // Quoted back because an agent can have more than one widget outstanding.
    expect(message).toContain('"Which database?"');
  });

  it("never names this build's own widget id", () => {
    // The id is generated after the emission, so the agent has never seen it — naming it told
    // nobody anything and was most of what made the echoed line unreadable.
    const message = widgetAnswerMessage(ask, {
      widgetId: "44ea64d3-ddf4-45ef-b3d8-c87d7d8987e4",
      values: ["pg"],
      text: null,
    });
    expect(message).not.toContain("44ea64d3");
  });

  it("carries free text when the operator wrote some", () => {
    const message = widgetAnswerMessage(
      { ...ask, allowOther: true },
      { widgetId: "w-1", values: [], text: "neither, use libSQL" },
    );
    expect(message).toContain("neither, use libSQL");
    expect(message).toContain("(nothing chosen)");
  });
});

/**
 * The completion gate's live half (F22 / the completion gate).
 *
 * The declaration used to reach the Task row only when the agent's *process* exited — and an
 * agent that declares and then waits for the operator does not exit. A run could sit for minutes
 * having said `changes_ready` with the board still drawing it as working, and refreshing the page
 * would not have helped: there was nothing to fetch.
 */
describe("the agent's completion declaration", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });
  beforeEach(() => {
    db = createTestDb();
  });

  /** The fence is only scanned where the widget flag is on, so every test here turns it on. */
  async function enableWidgets(ids: ReturnType<typeof freshIds>): Promise<void> {
    await db
      .update(workspace)
      .set({ enabledFlags: { "ff-agent-widgets": true } })
      .where(eq(workspace.id, ids.workspaceId));
  }

  const declaration = (outcome: string, summary?: string): AgentStreamEvent => ({
    kind: "stdout",
    channel: "assistant",
    text: [
      "```gatecontrol:widget",
      JSON.stringify({ kind: "task_complete", outcome, ...(summary ? { summary } : {}) }),
      "```",
    ].join("\n"),
  });

  it("reaches the Task row while the agent is still running", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    await enableWidgets(ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [declaration("changes_ready", "Pinned 6 dependencies")],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const [row] = await db.select().from(task).where(eq(task.id, ids.taskId));
    expect(row?.completedOutcome).toBe("changes_ready");
    expect(row?.completedSummary).toBe("Pinned 6 dependencies");
    expect(row?.completedAt).not.toBeNull();
  });

  it("announces it, because the Task's state has not changed to carry the news", async () => {
    // Nothing else would tell the board: the card gains its control on this publish alone.
    const ids = freshIds();
    await seedRun(db, ids);
    await enableWidgets(ids);
    const runner = new ScriptedRunner([{ kind: "completed" }], [declaration("changes_ready")]);
    const { deps, spies } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const statuses = spies.published.filter((p) => p.event["kind"] === "status");
    expect(statuses.some((p) => p.event["state"] === "running")).toBe(true);
  });

  it("keeps the last declaration when an agent declares twice", async () => {
    // An agent can say it is done and then keep working; what counts is the last one standing.
    const ids = freshIds();
    await seedRun(db, ids);
    await enableWidgets(ids);
    const runner = new ScriptedRunner(
      [{ kind: "completed" }],
      [declaration("nothing_to_do"), declaration("changes_ready", "actually did something")],
    );
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const [row] = await db.select().from(task).where(eq(task.id, ids.taskId));
    expect(row?.completedOutcome).toBe("changes_ready");
    expect(row?.completedSummary).toBe("actually did something");
  });

  it("records `nothing_to_do` as itself, so the board offers no gate over an empty change", async () => {
    const ids = freshIds();
    await seedRun(db, ids);
    await enableWidgets(ids);
    const runner = new ScriptedRunner([{ kind: "completed" }], [declaration("nothing_to_do")]);
    const { deps } = makeDeps(db, runner, nullStream());

    await runTaskLifecycle(deps, { event: { data: ids }, step: scriptedStep(["approve"]) });

    const [row] = await db.select().from(task).where(eq(task.id, ids.taskId));
    expect(row?.completedOutcome).toBe("nothing_to_do");
  });
});
