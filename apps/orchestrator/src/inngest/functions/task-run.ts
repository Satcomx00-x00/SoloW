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
import { AcpAgentRunner } from "../../agent/acp-runner.js";
import { type AgentRegistry, agentRegistry } from "../../agent/registry.js";
import type { AgentRunner } from "../../agent/runner.js";
import { prepareAgentEnv } from "../../billing/guard.js";
import {
  appendSessionEvent,
  loadTaskRunContext,
  nextSessionEventSeq,
  setSessionState,
  setTaskState,
  type TaskRunContext,
} from "../../data.js";
import { orchestratorEnv } from "../../env.js";
import {
  cleanupWorktree,
  commitWorktree,
  diffWorktree,
  discardWorktreeChanges,
  hasChanges,
  provisionWorktree,
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

/** Worktree operations the lifecycle depends on (real impls in `defaultDeps`). */
export interface WorktreeOps {
  provision: typeof provisionWorktree;
  commit: typeof commitWorktree;
  discard: typeof discardWorktreeChanges;
  cleanup: typeof cleanupWorktree;
  hasChanges: typeof hasChanges;
  diff: typeof diffWorktree;
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
  agentInvocation: () => { command: string; args: string[] };
}

/** Production wiring. */
export function defaultDeps(): TaskRunDeps {
  const env = orchestratorEnv();
  return {
    db: createDb(),
    runner: new AcpAgentRunner(),
    worktreeRoot: env.GATECONTROL_WORKTREE_ROOT,
    repoCacheRoot: env.GATECONTROL_REPO_CACHE_ROOT,
    logger: createLogger({ service: "orchestrator" }),
    worktree: {
      provision: provisionWorktree,
      commit: commitWorktree,
      discard: discardWorktreeChanges,
      cleanup: cleanupWorktree,
      hasChanges,
      diff: diffWorktree,
    },
    hub,
    registry: agentRegistry,
    // Which ACP-speaking agent binary to run. Configurable because the adapter that puts an
    // ACP face on Claude Code ships separately from Claude Code itself.
    agentInvocation: () => ({
      command: env.GATECONTROL_AGENT_COMMAND,
      args: env.GATECONTROL_AGENT_ARGS,
    }),
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

  const wt = await step.run("provision-worktree", () =>
    deps.worktree.provision({
      taskId,
      repository: { source: ctx.repository.source, location: ctx.repository.location },
      baseRef: ctx.task.baseRef ?? undefined,
      worktreeRoot: deps.worktreeRoot,
      repoCacheRoot: deps.repoCacheRoot,
    }),
  );
  logWorktreeBinding(log, { workspaceId, taskId, worktreePath: wt.path });

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

  /** Feedback from the previous review round; it becomes the next round's brief. */
  let pendingFeedback: string | undefined;

  for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
    const brief = agentBrief(ctx, pendingFeedback);
    const run = await step.run(`agent-run-${round}`, async () => {
      const shaped = prepareAgentEnv({
        authMode: ctx.agentProfile.authMode,
        secretCiphertext: ctx.secretCiphertext,
        baseEnv: process.env,
      });
      if (!shaped.ok) return { kind: "failed" as const, cls: "credential_expired" as const };

      // Every streamed event is published live *and* appended to the session log, so a client
      // that reconnects can replay from `seq` instead of losing history (TASK-018). Writes are
      // chained to keep log order identical to stream order.
      let seq = await nextSessionEventSeq(db, workspaceId, sessionId);
      let writes: Promise<unknown> = Promise.resolve();
      const emit = (kind: "stdout" | "tool_use", payload: Record<string, unknown>) => {
        const at = seq++;
        deps.hub.publish(channel, { kind, taskId, sessionId, seq: at, ...payload });
        writes = writes
          .then(() => appendSessionEvent(db, workspaceId, { sessionId, seq: at, kind, payload }))
          .catch((cause) => captureException(log, cause, { stage: "session-event-append" }));
      };

      const { command, args } = deps.agentInvocation();
      const handle = deps.runner.start({
        command,
        args,
        cwd: wt.path,
        env: shaped.data,
        prompt: brief,
        onEvent: (e) => {
          if (e.kind === "stdout") emit("stdout", { text: e.text });
          else emit("tool_use", { name: e.name });
        },
      });
      // Publish the handle for the lifetime of the run so the hub can deliver the operator's
      // input or stop to *this* agent (TASK-022), and withdraw it the moment the run ends.
      const deregister = deps.registry.register(workspaceId, { taskId, sessionId, handle });
      let outcome: Awaited<typeof handle.outcome>;
      try {
        outcome = await handle.outcome;
      } finally {
        deregister();
      }
      await writes;
      if (outcome.kind === "failed") {
        return { kind: "failed" as const, cls: classifyRunFailure(outcome.signal) };
      }
      const changed = await deps.worktree.hasChanges(wt.path);
      return { kind: "completed" as const, changed };
    });

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
    await step.run(`to-review-${round}`, async () => {
      await setTaskState(db, workspaceId, taskId, "review");
      await setSessionState(db, workspaceId, sessionId, "awaiting_review", {
        diffRef: wt.branch,
      });

      // Capture the change now, while the worktree still exists: approving removes it, and a
      // reviewer looking at a finished Task should still be able to see what they approved.
      // A capture failure must not block the review gate — the branch name alone is enough to
      // decide on, so this degrades to "no diff shown" rather than stalling the Task.
      try {
        const captured = await deps.worktree.diff(wt.path);
        await appendSessionEvent(db, workspaceId, {
          sessionId,
          seq: await nextSessionEventSeq(db, workspaceId, sessionId),
          kind: "diff",
          payload: { diffRef: wt.branch, ...captured },
        });
      } catch (cause) {
        captureException(log, cause, { stage: "diff-capture" });
      }

      deps.hub.publish(channel, { kind: "diff", taskId, sessionId, diffRef: wt.branch });
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
        await deps.worktree.commit(wt.path, `GateControl: task ${taskId}`);
        await setTaskState(db, workspaceId, taskId, "done", { resultBranch: wt.branch });
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
        await deps.worktree.discard(wt.path);
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

  await step.run("cleanup", () => deps.worktree.cleanup(wt.repoPath, wt.path));
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
