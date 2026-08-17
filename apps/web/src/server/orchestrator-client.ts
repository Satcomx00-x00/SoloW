import "server-only";
import type { ReviewDecision } from "@gatecontrol/contracts";

/**
 * Thin client the API uses to hand work to the orchestrator service (Decision 0002).
 * The API never runs agents itself; it emits events the durable `task-run` workflow
 * consumes (plan §9).
 *
 * TODO(Phase 3): wire to Inngest — `enqueueTaskRun` sends `task.launch.requested`;
 * `resumeReview` sends `review.decided` to release the workflow's `waitForEvent`.
 * Kept as a stable interface so routers are complete now.
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

/** Placeholder until Phase 3 wires Inngest; makes the boundary explicit, not silent. */
export const orchestrator: OrchestratorClient = {
  async enqueueTaskRun() {
    throw new Error("orchestrator not wired (Phase 3): task-run enqueue unavailable");
  },
  async resumeReview() {
    throw new Error("orchestrator not wired (Phase 3): review resume unavailable");
  },
};
