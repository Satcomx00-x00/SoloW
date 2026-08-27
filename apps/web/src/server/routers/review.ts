import "server-only";
import { reviewDecisionInput, reviewDto } from "@solow/contracts";
import { STRANDED_REVIEW_REASON } from "@solow/core";
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
      // and close the session on a terminal decision.
      //
      // Normally skipped once a real engine is wired — there the durable `task-run` sits parked
      // at its `waitForEvent("review.decided")` and owns the transition, so writing it here too
      // would race it. The tell for "a run is parked" is the Session state: `task-run` sets it to
      // `awaiting_review` immediately before it parks. So a wired engine with the Session still
      // `awaiting_review` means the run is there to apply this — leave it. Any OTHER Session state
      // means no run is parked to receive the event we just published: the local Inngest Dev
      // Server holds runs in memory and loses parked ones on restart (see `scripts/dev.sh
      // --persist`), which strands the Task in `review` with an un-decidable gate. Applying the
      // transition here then is a recovery, not a race — there is nothing to race.
      //
      // Dev-owner only, exactly as before: a hosted deployment runs a persistent engine and must
      // not have the API second-guess whether a run is parked (Principle VII).
      const engineOwnsTransition = orchestrator.isWired() && session.state === "awaiting_review";
      if (devOwnerMode() && !engineOwnsTransition) {
        /*
         * **Only reject may be applied on this path.**
         *
         * Approve claims the change was *integrated* — and integration is the orchestrator's
         * alone: committing means reaching a worktree through an Executor, which is the boundary
         * this process sits on the wrong side of by design. Request-changes claims an agent is
         * *running*, and no process here starts one. Reject alone is pure state: back to
         * `ready`, no claim about the work at all.
         *
         * So writing `done` here was reporting a success nobody achieved. Observed end to end on
         * 2026-08-27: an agent edited a file, the reviewer approved, the Task went Done, and the
         * branch still pointed at the commit before the run — the work sat uncommitted in a
         * worktree nothing would ever clean up, with no error anywhere on screen. That is the
         * worst failure a review gate can have: it is indistinguishable from having worked.
         *
         * `STRANDED_REVIEW_REASON` already names exactly this and the board already renders it —
         * "Decision not applied", with Retry. Nothing is lost: the decision is recorded above,
         * the change is intact on its branch, and what failed is the delivery.
         */
        /*
         * `request_changes` may not be applied here either, for the sibling reason.
         *
         * The durable path resumes the agent because the parked run consumes `review.decided`
         * and starts the next round itself. On this path there is no run to consume it, so
         * writing `running` produces a Task that *says* an agent is working while no process
         * exists anywhere — the exact zombie this codebase already documents ("a Task's input
         * box answering 'No agent is running' forever"), fixed only by the orchestrator's next
         * boot-time reconcile. A state must not claim more than this process did.
         *
         * Both therefore land on `STRANDED_REVIEW_REASON`: decision recorded, delivery failed,
         * Retry redrives a fresh run. One honest limit, stated rather than hidden — a redriven
         * run starts from the Task brief, so the reviewer's feedback reaches the record (the
         * review row above holds it) but not the next agent's prompt. That loses less than a
         * permanently fake "Running".
         *
         * Reject stays applicable: it is pure state — back to `ready`, no claim that anything
         * happened to the work — and refusing it too would leave a stranded Task with no exit
         * that does not go through Retry.
         */
        if (input.decision !== "reject") {
          unwrap(
            await updateTaskState(ctx.rctx, session.taskId, "failed", {
              failureReason: STRANDED_REVIEW_REASON,
            }),
          );
          // The session is closed too, not left `active`: no process holds it, and the Issue
          // above derives "in progress" from any active session — a stranded Task would keep
          // its Issue reading as worked-on forever. Retry opens a fresh Session of its own.
          await setSessionState(ctx.rctx, input.sessionId, "closed", {
            endedAt: new Date().toISOString(),
          });
          return review;
        }
        unwrap(await updateTaskState(ctx.rctx, session.taskId, DECISION_TASK_STATE.reject));
        await setSessionState(ctx.rctx, input.sessionId, "closed", {
          endedAt: new Date().toISOString(),
        });
      }

      return review;
    }),
});
