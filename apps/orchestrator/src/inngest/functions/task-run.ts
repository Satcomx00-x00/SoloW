import { z } from "zod";
import { reviewDecisionSchema } from "@gatecontrol/contracts";
import { classifyRunFailure } from "@gatecontrol/core";
import { createDb } from "@gatecontrol/db";
import { prepareAgentEnv } from "../../billing/guard.js";
import { orchestratorEnv } from "../../env.js";
import {
  type AgentRunner,
  SpawnAgentRunner,
} from "../../agent/runner.js";
import { hub } from "../../ws/hub.js";
import {
  cleanupWorktree,
  commitWorktree,
  discardWorktreeChanges,
  hasChanges,
  provisionWorktree,
} from "../../worktree/manager.js";
import {
  loadTaskRunContext,
  setSessionState,
  setTaskState,
} from "../../data.js";
import { inngest } from "../client.js";

/**
 * Durable Task lifecycle (plan §9 / task TASK-019). Steps are resumable: an orchestrator
 * restart resumes from the last completed step (Principle III). The review gate is a
 * `waitForEvent` (Principle I — no integration without a recorded human decision).
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

/** How to invoke the agent CLI (v1: Claude Code over ACP). */
function agentInvocation(): { command: string; args: string[] } {
  // TODO(TASK-014 integration): exact ACP flags for `claude`. Kept behind the runner
  // interface so orchestration is stable regardless of the transport details.
  return { command: "claude", args: ["--acp"] };
}

export const taskRun = inngest.createFunction(
  { id: "task-run", retries: 2, triggers: [{ event: "task.launch.requested" }] },
  async ({ event, step }) => {
    const { workspaceId, taskId, sessionId } = launchData.parse(event.data);
    const db = createDb();
    const env = orchestratorEnv();
    const runner: AgentRunner = new SpawnAgentRunner();

    const ctx = await step.run("load", () => loadTaskRunContext(db, workspaceId, taskId));

    const wt = await step.run("provision-worktree", () =>
      provisionWorktree({
        taskId,
        repository: { source: ctx.repository.source, location: ctx.repository.location },
        baseRef: ctx.task.baseRef ?? undefined,
        worktreeRoot: env.GATECONTROL_WORKTREE_ROOT,
        repoCacheRoot: env.GATECONTROL_REPO_CACHE_ROOT,
      }),
    );

    const channel = hub.taskChannel(workspaceId, taskId);

    for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
      const run = await step.run(`agent-run-${round}`, async () => {
        const shaped = prepareAgentEnv({
          authMode: ctx.agentProfile.authMode,
          secretCiphertext: ctx.secretCiphertext,
          baseEnv: process.env,
        });
        if (!shaped.ok) return { kind: "failed" as const, cls: "credential_expired" as const };

        const { command, args } = agentInvocation();
        const handle = runner.start({
          command,
          args,
          cwd: wt.path,
          env: shaped.data,
          onEvent: (e) => {
            if (e.kind === "stdout") {
              hub.publish(channel, { kind: "stdout", taskId, sessionId, seq: 0, text: e.text });
            } else {
              hub.publish(channel, { kind: "tool_use", taskId, sessionId, seq: 0, name: e.name });
            }
          },
        });
        const outcome = await handle.outcome;
        if (outcome.kind === "failed") {
          return { kind: "failed" as const, cls: classifyRunFailure(outcome.signal) };
        }
        const changed = await hasChanges(wt.path);
        return { kind: "completed" as const, changed };
      });

      if (run.kind === "failed") {
        if (run.cls === "park") {
          await step.run(`park-${round}`, () => setTaskState(db, workspaceId, taskId, "parked"));
          // Resume when the quota window resets (~5h). A budget/quota check would refine this.
          await step.sleepUntil(`park-wait-${round}`, new Date(Date.now() + 5 * 60 * 60 * 1000));
          continue;
        }
        // credential_expired or hard failure: pause/stop with the reason preserved.
        await step.run(`fail-${round}`, () =>
          setTaskState(db, workspaceId, taskId, "failed", { failureReason: run.cls }),
        );
        return { taskId, result: run.cls };
      }

      // Completed: move to review and wait for a human decision.
      await step.run(`to-review-${round}`, async () => {
        await setTaskState(db, workspaceId, taskId, "review");
        await setSessionState(db, workspaceId, sessionId, "awaiting_review", {
          diffRef: wt.branch,
        });
        hub.publish(channel, { kind: "diff", taskId, sessionId, diffRef: wt.branch });
      });

      const decidedEvent = await step.waitForEvent(`await-review-${round}`, {
        event: "review.decided",
        timeout: "7d",
        match: "data.sessionId",
      });
      if (!decidedEvent) return { taskId, result: "review_timeout" };

      const { decision } = reviewData.parse(decidedEvent.data);

      if (decision === "approve") {
        await step.run(`approve-${round}`, async () => {
          await commitWorktree(wt.path, `GateControl: task ${taskId}`);
          await setTaskState(db, workspaceId, taskId, "done", { resultBranch: wt.branch });
          await setSessionState(db, workspaceId, sessionId, "closed", {
            endedAt: new Date().toISOString(),
          });
        });
        break;
      }
      if (decision === "reject") {
        await step.run(`reject-${round}`, async () => {
          await discardWorktreeChanges(wt.path);
          await setTaskState(db, workspaceId, taskId, "ready");
        });
        break;
      }
      // request_changes: resume the agent for another round.
      await step.run(`resume-${round}`, () => setTaskState(db, workspaceId, taskId, "running"));
    }

    await step.run("cleanup", () => cleanupWorktree(wt.repoPath, wt.path));
    return { taskId, result: "done" };
  },
);
