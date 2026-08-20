import "server-only";
import type { ReviewDecision } from "@gatecontrol/contracts";
import { devOwnerMode, orchestratorUrl } from "./env.js";

/**
 * Thin client the API uses to hand work to the orchestrator service (Decision 0002).
 * The API never runs agents itself; it emits events the durable `task-run` workflow
 * consumes (plan §9).
 *
 * Transport: when `GATECONTROL_ORCHESTRATOR_URL` is set, events are POSTed to that service's
 * `/events` endpoint as `{ name, data }` — the shape Inngest's own event API uses, so the
 * hosted deployment can point at Inngest and the local one at the orchestrator process. The
 * orchestrator's own `/events` route (`apps/orchestrator/src/inngest/events.ts`) forwards
 * every POST into a real `inngest.send()`, so this is a genuine handoff to the durable engine
 * (Decision 0004), not a stub. Without `GATECONTROL_ORCHESTRATOR_URL`, dev mode logs-and-returns
 * so the SPA flow stays demonstrable, and non-dev throws so missing wiring is never silent.
 */
export interface OrchestratorClient {
  /** True when events actually reach a workflow engine (vs. the dev log-and-return path). */
  isWired(): boolean;
  enqueueTaskRun(input: { workspaceId: string; taskId: string; sessionId: string }): Promise<void>;
  /**
   * Ask the durable engine to cancel a Task's in-flight run. Fire-and-acknowledge: a 202 means
   * the engine accepted the cancellation, not that the agent process is already gone — Inngest
   * cancels between steps, so the run unwinds shortly after. Callers that need the row to be
   * safe to delete must re-check state after this returns, which `deleteIssue` does inside its
   * own transaction.
   */
  stopTaskRun(input: { workspaceId: string; taskId: string; sessionId: string }): Promise<void>;
  resumeReview(input: {
    workspaceId: string;
    sessionId: string;
    decision: ReviewDecision;
    feedback?: string | null;
  }): Promise<void>;
}

const UNWIRED = "orchestrator not configured (GATECONTROL_ORCHESTRATOR_URL unset)";

async function emit(name: string, data: unknown): Promise<void> {
  const base = orchestratorUrl();
  const res = await fetch(new URL("/events", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    throw new Error(`orchestrator rejected ${name}: ${res.status} ${await res.text()}`);
  }
}

export const orchestrator: OrchestratorClient = {
  isWired() {
    return orchestratorUrl() !== undefined;
  },

  async enqueueTaskRun(input) {
    if (orchestratorUrl()) return emit("task.launch.requested", input);
    if (devOwnerMode()) {
      console.info(`[orchestrator:dev] would enqueue task-run for task ${input.taskId}`);
      return;
    }
    throw new Error(`${UNWIRED}: task-run enqueue unavailable`);
  },

  async stopTaskRun(input) {
    if (orchestratorUrl()) return emit("task.stop.requested", input);
    if (devOwnerMode()) {
      console.info(`[orchestrator:dev] would stop task-run for task ${input.taskId}`);
      return;
    }
    throw new Error(`${UNWIRED}: task-run stop unavailable`);
  },

  async resumeReview(input) {
    if (orchestratorUrl()) return emit("review.decided", input);
    if (devOwnerMode()) {
      console.info(`[orchestrator:dev] would resume review for session ${input.sessionId}`);
      return;
    }
    throw new Error(`${UNWIRED}: review resume unavailable`);
  },
};
