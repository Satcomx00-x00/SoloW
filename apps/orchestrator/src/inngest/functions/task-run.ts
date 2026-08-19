import { reviewDecisionSchema, type TaskState } from "@gatecontrol/contracts";
import { classifyRunFailure } from "@gatecontrol/core";
import { createDb, type Db } from "@gatecontrol/db";
import {
  captureException,
  createLogger,
  type Logger,
  logStateTransition,
  logWorktreeBinding,
  withRunContext,
} from "@gatecontrol/observability";
import { z } from "zod";
import { ClaudeCodeRunner, worktreeNameForTask } from "../../agent/claude-code-runner.js";
import { hasAgentRunner, missingAgentRunnerReason } from "../../agent/protocols.js";
import { type AgentRegistry, agentRegistry } from "../../agent/registry.js";
import type { AgentRunner } from "../../agent/runner.js";
import { prepareAgentEnv } from "../../billing/guard.js";
import {
  appendSessionEvent,
  loadTaskRunContext,
  nextSessionEventSeq,
  nextSessionUsageSeq,
  recordSessionUsage,
  setSessionState,
  setTaskState,
  type TaskRunContext,
} from "../../data.js";
import { orchestratorEnv } from "../../env.js";
import { hasDriver, missingDriverReason } from "../../executor/drivers.js";
import { createLocalExecutor } from "../../executor/local.js";
import {
  adoptWorktree,
  cleanupWorktree,
  commitWorktree,
  diffWorktree,
  discardWorktreeChanges,
  hasChanges,
  type ProvisionParams,
  prepareRepository,
  type Worktree,
  type WorktreeDiff,
} from "../../worktree/manager.js";
import { hub } from "../../ws/hub.js";
import { inngest } from "../client.js";

/**
 * Durable Task lifecycle (plan §9 / task TASK-019). Steps are resumable: an orchestrator
 * restart resumes from the last completed step (Principle III). The review gate is a
 * `waitForEvent` (Principle I — no integration without a recorded human decision).
 *
 * The lifecycle body is factored into `runTaskLifecycle(deps, …)` so its collaborators (agent
 * runner, worktree ops, hub, db) can be injected — the Inngest function wires the real ones,
 * and the integration test (TASK-020) drives it with a fake ACP agent + a controllable step.
 */

const launchData = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
});

const reviewData = z.object({
  sessionId: z.string().min(1),
  decision: reviewDecisionSchema,
  feedback: z.string().nullish(),
});

const MAX_REVIEW_ROUNDS = 5;

/**
 * Worktree operations the lifecycle depends on (real impls in `defaultDeps`), already bound to
 * an `Executor` (issue #1) — the lifecycle itself stays executor-agnostic.
 */
export interface WorktreeOps {
  /**
   * Resolve the repository the agent will run in. GateControl no longer creates the Task's
   * worktree — `claude --worktree` does — so there is no `provision` step here any more.
   */
  prepare(params: ProvisionParams): Promise<string>;
  /** Confirm with git that the path the agent reported really is a worktree of the repository. */
  adopt(repoPath: string, reportedPath: string | null): Promise<Worktree>;
  commit(path: string, message: string): Promise<void>;
  discard(path: string): Promise<void>;
  cleanup(repoPath: string, worktree: string): Promise<void>;
  hasChanges(path: string): Promise<boolean>;
  diff(path: string): Promise<WorktreeDiff>;
}

/** The bits of the WS hub the lifecycle uses. */
export interface HubLike {
  taskChannel(workspaceId: string, taskId: string): string;
  boardChannel(workspaceId: string): string;
  publish(channel: string, event: unknown): void;
}

/** Injected collaborators for the Task lifecycle. */
export interface TaskRunDeps {
  db: Db;
  runner: AgentRunner;
  worktreeRoot: string;
  repoCacheRoot: string;
  logger: Logger;
  worktree: WorktreeOps;
  hub: HubLike;
  /** Where the hub finds the agent belonging to a Task, to deliver input or a stop. */
  registry: AgentRegistry;
}

/** Production wiring. */
export function defaultDeps(): TaskRunDeps {
  const env = orchestratorEnv();
  // One local executor (issue #1) for the whole lifecycle: today the only kind, tomorrow one of
  // several a Task's Executor Profile can select — everything below reaches the host through it.
  const executor = createLocalExecutor(env.GATECONTROL_WORKTREE_ROOT);
  return {
    db: createDb(),
    runner: new ClaudeCodeRunner({ executor }),
    worktreeRoot: env.GATECONTROL_WORKTREE_ROOT,
    repoCacheRoot: env.GATECONTROL_REPO_CACHE_ROOT,
    logger: createLogger({ service: "orchestrator" }),
    worktree: {
      prepare: (params) => prepareRepository(executor, params),
      adopt: (repoPath, reportedPath) => adoptWorktree(executor, repoPath, reportedPath),
      commit: (path, message) => commitWorktree(executor, path, message),
      discard: (path) => discardWorktreeChanges(executor, path),
      cleanup: (repoPath, worktree) => cleanupWorktree(executor, repoPath, worktree),
      hasChanges: (path) => hasChanges(executor, path),
      diff: (path) => diffWorktree(executor, path),
    },
    hub,
    registry: agentRegistry,
  };
}

/** Minimal shape of the Inngest step tools the lifecycle uses (also satisfied by test fakes). */
export interface StepLike {
  run<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
  waitForEvent(
    id: string,
    opts: { event: string; timeout: string; match: string },
  ): Promise<{ data: unknown } | null>;
  sleepUntil(id: string, until: Date): Promise<void>;
}

export interface TaskRunArgs {
  event: { data: unknown };
  step: StepLike;
}

export async function runTaskLifecycle(
  deps: TaskRunDeps,
  { event, step }: TaskRunArgs,
): Promise<{ taskId: string; result: string }> {
  const { workspaceId, taskId, sessionId } = launchData.parse(event.data);
  const { db } = deps;
  const log = withRunContext(deps.logger, { workspaceId, taskId, sessionId });

  const ctx = await step.run("load", () => loadTaskRunContext(db, workspaceId, taskId));

  const channel = deps.hub.taskChannel(workspaceId, taskId);
  const boardChannel = deps.hub.boardChannel(workspaceId);

  /** Announce a Task state change on the Workspace board channel (the SPA board listens here). */
  const announce = (state: TaskState) =>
    deps.hub.publish(boardChannel, {
      kind: "status",
      taskId,
      state,
      at: new Date().toISOString(),
    });

  /**
   * An Agent Profile names the protocol its catalog row declares, and only some protocols have
   * a runner behind them yet (issue #10). Checked here, before anything is cloned: a Task
   * pointed at an `acp` catalog entry must fail with a legible reason, not crash deep inside a
   * runner that was never built to speak it.
   */
  if (!hasAgentRunner(ctx.agentCatalog.protocol)) {
    const reason = missingAgentRunnerReason(ctx.agentCatalog.protocol);
    await step.run("agent-runner-unavailable", () =>
      setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason }),
    );
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(reason), { failureReason: reason });
    return { taskId, result: "failed" as const };
  }

  /**
   * A Task names the Executor Profile it runs under, and only some kinds have a driver behind
   * them (issue #73). Checked here, before anything is cloned: a Task pointed at a Docker
   * profile must not quietly run on the orchestrator's own host and report success — the user
   * asked for isolation and would not have got it.
   */
  if (!hasDriver(ctx.executorProfile.kind)) {
    const reason = missingDriverReason(ctx.executorProfile.kind);
    await step.run("executor-unavailable", () =>
      setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason }),
    );
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(reason), { failureReason: reason });
    return { taskId, result: "failed" as const };
  }

  /**
   * The repository, not the Task's worktree.
   *
   * The agent creates the worktree itself (`claude --worktree`), which is what lets several
   * Tasks run against one repository at a time (Principle II). This step still resolves and
   * validates the repository up front, so an unusable location fails the Task before any agent
   * starts rather than surfacing as a confusing agent error later (TASK-015).
   */
  const repoPath = await step.run("prepare-repository", () =>
    deps.worktree.prepare({
      taskId,
      repository: { source: ctx.repository.source, location: ctx.repository.location },
      baseRef: ctx.task.baseRef ?? undefined,
      worktreeRoot: deps.worktreeRoot,
      repoCacheRoot: deps.repoCacheRoot,
    }),
  );

  /**
   * Set once the first round adopts the worktree the agent made. Every later step — diff,
   * commit, discard, cleanup — acts on this, so it is read from the agent rather than assumed.
   */
  let wt: { path: string; branch: string; repoPath: string } | null = null;

  /** Feedback from the previous review round; it becomes the next round's brief. */
  let pendingFeedback: string | undefined;

  for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
    const brief = agentBrief(ctx, pendingFeedback);
    const run = await step.run(`agent-run-${round}`, async () => {
      const shaped = prepareAgentEnv({
        authMode: ctx.agentProfile.authMode,
        secretCiphertext: ctx.secretCiphertext,
        baseEnv: process.env,
        subscriptionEnvVar: ctx.agentCatalog.subscriptionEnvVar,
        meteredEnvVar: ctx.agentCatalog.meteredEnvVar,
        // The Executor Profile's environment (issue #73). It is applied under the credential
        // shaping, never over it, so a profile cannot become a route to metered billing.
        profileEnv: ctx.executorProfile.config.env ?? {},
      });
      if (!shaped.ok) return { kind: "failed" as const, cls: "credential_expired" as const };

      // Every streamed event is published live *and* appended to the session log, so a client
      // that reconnects can replay from `seq` instead of losing history (TASK-018). Writes are
      // chained to keep log order identical to stream order.
      let seq = await nextSessionEventSeq(db, workspaceId, sessionId);
      let writes: Promise<unknown> = Promise.resolve();
      // Usage is recorded per turn as it is reported (issue #14) — the agent states it once,
      // in its own stream, and nothing else in the system can reconstruct it afterwards.
      //
      // The CLI emits one event per *content block* of a turn and repeats that turn's usage on
      // every one, so the turn id is the identity: a repeat is dropped here rather than
      // multiplying the turn's counts by its block count. `seq` only orders, and is read back
      // from the database because a Session outlives a single durable step (review rounds).
      let usageSeq = await nextSessionUsageSeq(db, workspaceId, sessionId);
      const seenTurns = new Set<string>();
      const recordUsage = (u: {
        messageId: string | null;
        reported: boolean;
        model: string | null;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      }) => {
        const seq = usageSeq;
        // A CLI that reports no turn id gets one derived from position — still stable under
        // replay, because the sequence itself is read back from the database each round.
        const messageId = u.messageId ?? `seq:${seq}`;
        if (seenTurns.has(messageId)) return;
        seenTurns.add(messageId);
        usageSeq += 1;
        writes = writes
          .then(() =>
            recordSessionUsage(db, workspaceId, {
              sessionId,
              taskId,
              agentProfileId: ctx.agentProfile.id,
              messageId,
              seq,
              reported: u.reported,
              model: u.model,
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
              cacheWriteTokens: u.cacheWriteTokens,
            }),
          )
          .catch((cause) => captureException(log, cause, { stage: "session-usage-record" }));
      };

      const emit = (kind: "stdout" | "tool_use", payload: Record<string, unknown>) => {
        const at = seq++;
        deps.hub.publish(channel, { kind, taskId, sessionId, seq: at, ...payload });
        writes = writes
          .then(() => appendSessionEvent(db, workspaceId, { sessionId, seq: at, kind, payload }))
          .catch((cause) => captureException(log, cause, { stage: "session-event-append" }));
      };

      // Launch command and arguments come from the Agent's catalog row (issue #10) — not a
      // global env var, since two Agent Profiles in the same Workspace can point at different
      // catalog entries.
      const { command, argsTemplate: args } = ctx.agentCatalog;
      // First round: run in the repository and have the agent create the Task's worktree.
      // Later rounds continue *inside* that worktree — a reviewer asking for changes wants the
      // work carried on, and asking for the worktree again would branch a fresh one from the
      // base ref and throw the earlier round away.
      const resuming = wt;
      const handle = deps.runner.start({
        command,
        args,
        cwd: resuming ? resuming.path : repoPath,
        env: shaped.data,
        worktreeName: resuming ? null : worktreeNameForTask(taskId),
        prompt: brief,
        onEvent: (e) => {
          if (e.kind === "stdout") emit("stdout", { text: e.text });
          else if (e.kind === "tool_use") emit("tool_use", { name: e.name });
          else recordUsage(e);
        },
      });
      // Publish the handle for the lifetime of the run so the hub can deliver the operator's
      // input or stop to *this* agent (TASK-022), and withdraw it the moment the run ends.
      const deregister = deps.registry.register(workspaceId, { taskId, sessionId, handle });
      let outcome: Awaited<typeof handle.outcome>;
      let reported: string | null = null;
      try {
        // Learn where the agent went as soon as it says so, before waiting on the run: if the
        // agent dies mid-run we still know which worktree to clean up.
        reported = await handle.workspacePath;
        outcome = await handle.outcome;
      } finally {
        deregister();
        // Drain queued log and usage writes even when the run threw. Usage in particular
        // cannot be re-obtained — the agent reports it once — so abandoning the chain on a
        // mid-turn failure would lose it permanently rather than merely delay it.
        await writes;
      }

      // Confirm with git that the reported path really is a worktree of this repository. An
      // agent working somewhere else has not been isolated, and committing from wherever it
      // happened to point would be worse than failing (Principle II). A resuming round is
      // re-checked too: the worktree could have been removed underneath us between rounds.
      let adopted: { path: string; branch: string; repoPath: string };
      try {
        adopted = await deps.worktree.adopt(repoPath, reported);
      } catch (cause) {
        captureException(log, cause, { stage: "worktree-adopt", reported });
        return { kind: "failed" as const, cls: "fail" as const };
      }

      if (outcome.kind === "failed") {
        return {
          kind: "failed" as const,
          cls: classifyRunFailure(outcome.signal),
          worktree: adopted,
        };
      }
      const changed = await deps.worktree.hasChanges(adopted.path);
      return { kind: "completed" as const, changed, worktree: adopted };
    });

    if (run.worktree) {
      wt = run.worktree;
      // The audit line binding a worktree to its Task (Principle IV) is emitted on adoption,
      // because that is the first moment GateControl knows which directory the agent used.
      logWorktreeBinding(log, { workspaceId, taskId, worktreePath: run.worktree.path });
    }

    if (run.kind === "failed") {
      if (run.cls === "park") {
        await step.run(`park-${round}`, () => setTaskState(db, workspaceId, taskId, "parked"));
        logStateTransition(log, { workspaceId, taskId, from: "running", to: "parked" });
        announce("parked");
        // Resume when the quota window resets (~5h). A budget/quota check would refine this.
        await step.sleepUntil(`park-wait-${round}`, new Date(Date.now() + 5 * 60 * 60 * 1000));
        continue;
      }
      // credential_expired or hard failure: pause/stop with the reason preserved.
      await step.run(`fail-${round}`, () =>
        setTaskState(db, workspaceId, taskId, "failed", { failureReason: run.cls }),
      );
      logStateTransition(log, { workspaceId, taskId, from: "running", to: "failed" });
      announce("failed");
      captureException(log, new Error(`task run failed: ${run.cls}`), { failureReason: run.cls });
      return { taskId, result: run.cls };
    }

    // Completed: move to review and wait for a human decision.
    const worktree = run.worktree;
    await step.run(`to-review-${round}`, async () => {
      await setTaskState(db, workspaceId, taskId, "review");
      await setSessionState(db, workspaceId, sessionId, "awaiting_review", {
        diffRef: worktree.branch,
      });

      // Capture the change now, while the worktree still exists: approving removes it, and a
      // reviewer looking at a finished Task should still be able to see what they approved.
      // A capture failure must not block the review gate — the branch name alone is enough to
      // decide on, so this degrades to "no diff shown" rather than stalling the Task.
      try {
        const captured = await deps.worktree.diff(worktree.path);
        await appendSessionEvent(db, workspaceId, {
          sessionId,
          seq: await nextSessionEventSeq(db, workspaceId, sessionId),
          kind: "diff",
          payload: { diffRef: worktree.branch, ...captured },
        });
      } catch (cause) {
        captureException(log, cause, { stage: "diff-capture" });
      }

      deps.hub.publish(channel, { kind: "diff", taskId, sessionId, diffRef: worktree.branch });
    });
    logStateTransition(log, { workspaceId, taskId, from: "running", to: "review" });
    announce("review");

    const decidedEvent = await step.waitForEvent(`await-review-${round}`, {
      event: "review.decided",
      timeout: "7d",
      match: "data.sessionId",
    });
    if (!decidedEvent) return { taskId, result: "review_timeout" };

    const { decision, feedback } = reviewData.parse(decidedEvent.data);

    if (decision === "approve") {
      await step.run(`approve-${round}`, async () => {
        await deps.worktree.commit(worktree.path, `GateControl: task ${taskId}`);
        await setTaskState(db, workspaceId, taskId, "done", { resultBranch: worktree.branch });
        await setSessionState(db, workspaceId, sessionId, "closed", {
          endedAt: new Date().toISOString(),
        });
      });
      logStateTransition(log, { workspaceId, taskId, from: "review", to: "done" });
      announce("done");
      break;
    }
    if (decision === "reject") {
      await step.run(`reject-${round}`, async () => {
        await deps.worktree.discard(worktree.path);
        await setTaskState(db, workspaceId, taskId, "ready");
      });
      logStateTransition(log, { workspaceId, taskId, from: "review", to: "ready" });
      announce("ready");
      break;
    }
    // request_changes: resume the agent for another round, carrying the reviewer's feedback —
    // without it the next round would repeat the same brief and produce the same work.
    pendingFeedback = feedback ?? undefined;
    await step.run(`resume-${round}`, () => setTaskState(db, workspaceId, taskId, "running"));
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "running" });
    announce("running");
  }

  const adopted = wt;
  if (adopted) {
    await step.run("cleanup", () => deps.worktree.cleanup(adopted.repoPath, adopted.path));
  }
  return { taskId, result: "done" };
}

/**
 * The brief handed to the agent. Round one is the Issue and the Task; later rounds lead with the
 * reviewer's feedback, because that — not the original brief — is what still needs doing.
 */
export function agentBrief(ctx: TaskRunContext, feedback?: string | undefined): string {
  const parts = [`# Task\n${ctx.task.title}`, `# Issue\n${ctx.issue.title}`];
  if (ctx.issue.description) parts.push(ctx.issue.description);
  if (feedback?.trim()) {
    parts.push(
      `# Review feedback\nYour previous attempt was not accepted. Address this feedback:\n${feedback.trim()}`,
    );
  }
  return parts.join("\n\n");
}

export const taskRun = inngest.createFunction(
  { id: "task-run", retries: 2, triggers: [{ event: "task.launch.requested" }] },
  (args) => runTaskLifecycle(defaultDeps(), args as unknown as TaskRunArgs),
);
