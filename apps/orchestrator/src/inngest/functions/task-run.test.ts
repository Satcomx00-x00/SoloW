/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Writable } from "node:stream";
import { type AgentProtocol, type ExecutorConfig, TaskErrorCode } from "@gatecontrol/contracts";
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
    // Round 0 writes seq 0; the review gate then records the transition and the diff, and the
    // resume records another transition, so round 1's turn lands at seq 4 (issue #2 added the
    // `state` records — the sequence itself is unchanged, there is simply more in it).
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

    // One agent turn, the two transitions the run recorded, and the diff captured at the gate.
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
        { kind: "tool_use", name: "Edit" },
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
      { kind: "tool_call", name: "Edit", callId: null },
    ]);
    // The presentation marker is applied on the way to the wire and never stored, so what #16
    // and #84 read back is the agent's own text.
    expect(JSON.stringify(logged)).not.toContain("· considering");
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
    expect(transitions).toEqual([
      { kind: "state", from: "running", to: "review" },
      { kind: "state", from: "review", to: "done" },
    ]);
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
    expect(transitions).toEqual([
      { kind: "state", from: "running", to: "review" },
      { kind: "state", from: "review", to: "done" },
    ]);
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
        { kind: "tool_use", name: "Bash(echo oauth-token)" },
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
