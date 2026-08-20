import "server-only";
import { reviewDecisionInput, reviewDto } from "@gatecontrol/contracts";
import { recordReview } from "../dal/review.js";
import { getSessionById, setSessionState } from "../dal/session.js";
import { updateTaskState } from "../dal/task.js";
import { devOwnerMode } from "../env.js";
import { orchestrator } from "../orchestrator-client.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";
import { requireUnblocked } from "./task.js";

/** Review → resulting Task state (mirrors the orchestrator's integrate step, plan §9). */
const DECISION_TASK_STATE = {
  approve: "done",
  reject: "ready",
  request_changes: "running",
} as const;

export const reviewRouter = router({
  /**
   * Record a human decision on a Session's diff (Principle I). In a real deployment the
   * orchestrator's durable workflow finalizes the Task (approve → commit + Done; reject →
   * discard; request_changes → resume). In dev-owner mode the durable service isn't running,
   * so the transition is applied here so the local loop is demonstrable end-to-end.
   */
  decide: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/review.decide",
        tags: ["review"],
        protect: true,
        summary:
          "Record the human decision on a Session's diff: approve (commit), reject (discard), or request_changes (resume the agent with feedback). This is the review gate — nothing is integrated without it.",
      },
    })
    .input(reviewDecisionInput)
    .output(reviewDto)
    .mutation(async ({ ctx, input }) => {
      // Ownership: the Session must belong to this Workspace before we record a decision.
      const session = unwrap(await getSessionById(ctx.rctx, input.sessionId));

      // `request_changes` resumes the agent, so it is a start (issue #6 AC-3: "SHALL NOT start
      // it by any automated path"). The reading applied is the one `task.move` already applies —
      // the transition *into* `running` is the start, whoever asks for it — so a decision that
      // would set a blocked Task going is refused with the same code, rather than the same state
      // change being refused on the board and allowed here (and over MCP, where `review.decide`
      // is an exposed tool). Refused before anything is recorded or released, so a rejected
      // decision leaves no half-applied trail.
      //
      // Above the `devOwnerMode()` branch on purpose: the wired orchestrator applies the very
      // same transition, and which deployment is running must not decide whether a blocked Task
      // can be started (Principle VII).
      if (DECISION_TASK_STATE[input.decision] === "running") {
        await requireUnblocked(ctx.rctx, session.taskId);
      }

      const review = unwrap(
        await recordReview(ctx.rctx, {
          sessionId: input.sessionId,
          decision: input.decision,
          feedback: input.feedback ?? null,
        }),
      );

      // Release the decision to the durable workflow (dev: logs-and-returns).
      await orchestrator.resumeReview({
        workspaceId: ctx.rctx.workspaceId,
        sessionId: input.sessionId,
        decision: input.decision,
        feedback: input.feedback ?? null,
      });

      // Dev stand-in for the orchestrator's integrate step: apply the resulting Task state
      // and close the session on a terminal decision. Skipped once a real engine is wired —
      // there the workflow owns the transition, and writing it here too would race it.
      if (devOwnerMode() && !orchestrator.isWired()) {
        const nextState = DECISION_TASK_STATE[input.decision];
        unwrap(await updateTaskState(ctx.rctx, session.taskId, nextState));
        if (input.decision !== "request_changes") {
          await setSessionState(ctx.rctx, input.sessionId, "closed", {
            endedAt: new Date().toISOString(),
          });
        }
      }

      return review;
    }),
});
