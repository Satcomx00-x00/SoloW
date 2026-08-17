import { reviewDecisionSchema } from "@gatecontrol/contracts";
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
import { type AgentRunner, SpawnAgentRunner } from "../../agent/runner.js";
import { prepareAgentEnv } from "../../billing/guard.js";
import { loadTaskRunContext, setSessionState, setTaskState } from "../../data.js";
import { orchestratorEnv } from "../../env.js";
import {
  cleanupWorktree,
  commitWorktree,
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
}

/** The bits of the WS hub the lifecycle uses. */
export interface HubLike {
  taskChannel(workspaceId: string, taskId: string): string;
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
  agentInvocation: () => { command: string; args: string[] };
}

/** Production wiring. */
export function defaultDeps(): TaskRunDeps {
  const env = orchestratorEnv();
  return {
    db: createDb(),
    runner: new SpawnAgentRunner(),
    worktreeRoot: env.GATECONTROL_WORKTREE_ROOT,
    repoCacheRoot: env.GATECONTROL_REPO_CACHE_ROOT,
    logger: createLogger({ service: "orchestrator" }),
    worktree: {
      provision: provisionWorktree,
      commit: commitWorktree,
      discard: discardWorktreeChanges,
      cleanup: cleanupWorktree,
      hasChanges,
    },
    hub,
    // TODO(TASK-014 integration): exact ACP flags for `claude`. Kept behind the runner
    // interface so orchestration is stable regardless of the transport details.
    agentInvocation: () => ({ command: "claude", args: ["--acp"] }),
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

  for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
    const run = await step.run(`agent-run-${round}`, async () => {
      const shaped = prepareAgentEnv({
        authMode: ctx.agentProfile.authMode,
        secretCiphertext: ctx.secretCiphertext,
        baseEnv: process.env,
      });
      if (!shaped.ok) return { kind: "failed" as const, cls: "credential_expired" as const };

      const { command, args } = deps.agentInvocation();
      const handle = deps.runner.start({
        command,
        args,
        cwd: wt.path,
        env: shaped.data,
        onEvent: (e) => {
          if (e.kind === "stdout") {
            deps.hub.publish(channel, { kind: "stdout", taskId, sessionId, seq: 0, text: e.text });
          } else {
            deps.hub.publish(channel, {
              kind: "tool_use",
              taskId,
              sessionId,
              seq: 0,
              name: e.name,
            });
          }
        },
      });
      const outcome = await handle.outcome;
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
        // Resume when the quota window resets (~5h). A budget/quota check would refine this.
        await step.sleepUntil(`park-wait-${round}`, new Date(Date.now() + 5 * 60 * 60 * 1000));
        continue;
      }
      // credential_expired or hard failure: pause/stop with the reason preserved.
      await step.run(`fail-${round}`, () =>
        setTaskState(db, workspaceId, taskId, "failed", { failureReason: run.cls }),
      );
      logStateTransition(log, { workspaceId, taskId, from: "running", to: "failed" });
      captureException(log, new Error(`task run failed: ${run.cls}`), { failureReason: run.cls });
      return { taskId, result: run.cls };
    }

    // Completed: move to review and wait for a human decision.
    await step.run(`to-review-${round}`, async () => {
      await setTaskState(db, workspaceId, taskId, "review");
      await setSessionState(db, workspaceId, sessionId, "awaiting_review", {
        diffRef: wt.branch,
      });
      deps.hub.publish(channel, { kind: "diff", taskId, sessionId, diffRef: wt.branch });
    });
    logStateTransition(log, { workspaceId, taskId, from: "running", to: "review" });

    const decidedEvent = await step.waitForEvent(`await-review-${round}`, {
      event: "review.decided",
      timeout: "7d",
      match: "data.sessionId",
    });
    if (!decidedEvent) return { taskId, result: "review_timeout" };

    const { decision } = reviewData.parse(decidedEvent.data);

    if (decision === "approve") {
      await step.run(`approve-${round}`, async () => {
        await deps.worktree.commit(wt.path, `GateControl: task ${taskId}`);
        await setTaskState(db, workspaceId, taskId, "done", { resultBranch: wt.branch });
        await setSessionState(db, workspaceId, sessionId, "closed", {
          endedAt: new Date().toISOString(),
        });
      });
      logStateTransition(log, { workspaceId, taskId, from: "review", to: "done" });
      break;
    }
    if (decision === "reject") {
      await step.run(`reject-${round}`, async () => {
        await deps.worktree.discard(wt.path);
        await setTaskState(db, workspaceId, taskId, "ready");
      });
      logStateTransition(log, { workspaceId, taskId, from: "review", to: "ready" });
      break;
    }
    // request_changes: resume the agent for another round.
    await step.run(`resume-${round}`, () => setTaskState(db, workspaceId, taskId, "running"));
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "running" });
  }

  await step.run("cleanup", () => deps.worktree.cleanup(wt.repoPath, wt.path));
  return { taskId, result: "done" };
}

export const taskRun = inngest.createFunction(
  { id: "task-run", retries: 2, triggers: [{ event: "task.launch.requested" }] },
  (args) => runTaskLifecycle(defaultDeps(), args as unknown as TaskRunArgs),
);
