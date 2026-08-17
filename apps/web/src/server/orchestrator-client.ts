import "server-only";
import type { ReviewDecision } from "@gatecontrol/contracts";
import { devOwnerMode } from "./env.js";

/**
 * Thin client the API uses to hand work to the orchestrator service (Decision 0002).
 * The API never runs agents itself; it emits events the durable `task-run` workflow
 * consumes (plan §9).
 *
 * TODO(Phase 3 wiring): send real Inngest events — `enqueueTaskRun` → `task.launch.requested`;
 * `resumeReview` → `review.decided` (releases the workflow's `waitForEvent`). Until then, dev
 * mode logs-and-returns so the SPA flow is demonstrable, and non-dev throws so the missing
 * wiring is never silent in a real deployment.
 */
export interface OrchestratorClient {
  enqueueTaskRun(input: { workspaceId: string; taskId: string; sessionId: string }): Promise<void>;
  resumeReview(input: {
    workspaceId: string;
    sessionId: string;
    decision: ReviewDecision;
    feedback?: string | null;
  }): Promise<void>;
}

const UNWIRED = "orchestrator not wired (Phase 3)";

export const orchestrator: OrchestratorClient = {
  async enqueueTaskRun(input) {
    if (devOwnerMode()) {
      console.info(`[orchestrator:dev] would enqueue task-run for task ${input.taskId}`);
      return;
    }
    throw new Error(`${UNWIRED}: task-run enqueue unavailable`);
  },
  async resumeReview(input) {
    if (devOwnerMode()) {
      console.info(`[orchestrator:dev] would resume review for session ${input.sessionId}`);
      return;
    }
    throw new Error(`${UNWIRED}: review resume unavailable`);
  },
};
