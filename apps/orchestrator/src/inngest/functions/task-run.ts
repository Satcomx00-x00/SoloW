import { reviewDecisionSchema, stopReasonMeansTruncated } from "@solow/contracts";
import { captureException, logWorktreeBinding, withRunContext } from "@solow/observability";
import { z } from "zod";
import {
  compactSession,
  loadTaskRunContext,
  recordWorktree,
  takeUpReviewDecision,
} from "../../data.js";
import { inngest } from "../client.js";
import type { StepTransition } from "./task-run/advance.js";
import {
  continueTruncated,
  MAX_AUTO_CONTINUE_ROUNDS,
  MAX_REVIEW_ROUNDS,
  restartLostConversation,
} from "./task-run/budgets.js";
import { applyDecision } from "./task-run/decision.js";
import { defaultDeps } from "./task-run/deps.js";
import { finishRound } from "./task-run/finish.js";
import { prepareWorkspace, resolveEntry, TASK_RUN_RETRIES } from "./task-run/prepare.js";
import { runHarnessRound } from "./task-run/round.js";
import { createRunScope } from "./task-run/scope.js";
import { failRound, failRun, parkRound } from "./task-run/terminal.js";
import { createLoopState, type TaskRunArgs, type TaskRunDeps } from "./task-run/types.js";

export {
  type BriefContinuation,
  type BriefWorkspace,
  harnessBrief,
  widgetAnswerMessage,
} from "./task-run/brief.js";
export { defaultDeps } from "./task-run/deps.js";
export {
  allowlistToolInput,
  readTodoWrite,
  toolStatus,
  truncateToolOutput,
} from "./task-run/harness-events.js";
export { executorBindPaths } from "./task-run/prepare.js";
export { PARK_SLEEP_MS } from "./task-run/terminal.js";
export type {
  HubLike,
  StepLike,
  TaskRunArgs,
  TaskRunDeps,
  WorktreeOps,
} from "./task-run/types.js";

/**
 * Durable Task lifecycle (plan §9 / task TASK-019). Steps are resumable: an orchestrator
 * restart resumes from the last completed step (Principle III). The review gate is a state in
 * the database, not a pause in the engine: a run ends when it opens one, and the decision starts
 * the next run (Principle I — no integration without a recorded human decision).
 *
 * The lifecycle body is factored into `runTaskLifecycle(deps, …)` so its collaborators (harness
 * runner, worktree ops, hub, db) can be injected — the Inngest function wires the real ones,
 * and the integration test (TASK-020) drives it with a fake ACP agent + a controllable step.
 */

/**
 * What starts a run: a launch, or a person's decision at a review gate.
 *
 * A run never waits at a gate. It records the work, opens the gate and ends; the decision is a
 * row in `review`, and `review.decide` starts the next run with that row's id and contents here.
 * Waiting inside the engine (`waitForEvent`) made the gate as durable as the engine's pause
 * index, and the local Dev Server loses that on a restart: decisions were published to a run that
 * no longer existed, the gate kept its Approve button, and nothing anywhere failed. The database
 * holds the gate now, so a decision is either delivered as a run or refused where it was clicked.
 */
const launchData = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  review: z
    .object({
      id: z.string().min(1),
      decision: reviewDecisionSchema,
      feedback: z.string().nullish(),
    })
    .optional(),
});

export async function runTaskLifecycle(
  deps: TaskRunDeps,
  { event, step, attempt = 0 }: TaskRunArgs,
): Promise<{ taskId: string; result: string }> {
  const { workspaceId, taskId, sessionId, review: decidedReview } = launchData.parse(event.data);
  const { db } = deps;
  const log = withRunContext(deps.logger, { workspaceId, taskId, sessionId });

  const ctx = await step.run("load", () => loadTaskRunContext(db, workspaceId, taskId));

  /*
   * A run started by a decision takes it up before anything else — once.
   *
   * The event can be delivered twice, and a second application is not harmless: approving a
   * middle Step twice would move the cursor past the Step after it without that Step ever
   * running. The write is conditional, so the run that loses finds the decision spent and leaves
   * without touching the Task.
   */
  if (decidedReview) {
    const taken = await step.run("decision-take-up", () =>
      takeUpReviewDecision(db, workspaceId, sessionId, decidedReview.id),
    );
    if (!taken) return { taskId, result: "decision_already_applied" };
  }

  const scope = createRunScope({ deps, step, log, workspaceId, taskId, sessionId, ctx });

  const entry = await resolveEntry(scope, decidedReview);
  if (!entry.ok) return entry.result;
  const { wf, legForStep, checkpointStore, entryLeg, executor, worktreeOps, repoAdmin } = entry;

  try {
    const workspace = await prepareWorkspace(scope, entry, attempt);
    if (!workspace.ok) return workspace.result;
    const {
      entryRunner,
      primaryBinding,
      repoPath,
      upstreamPathFor,
      provisionedByAttachment,
      provisioned,
      seed,
      worktreeBindings,
      retainedPrimary,
    } = workspace;

    /** The loop's bindings — what a Step boundary, a decision and a round read and rebind. */
    const loop = createLoopState({ wt: provisioned, leg: entryLeg, runner: entryRunner });
    const transition: StepTransition = { wf, legForStep, checkpointStore, executor };

    /**
     * How many Steps this run believes the Workflow has.
     *
     * Read from the **memoized** `workflow-resume` output and from nowhere else. A live read
     * would let an edit change the loop bound between replays, and a replay that walked a
     * different number of iterations would reach a different step id than the journal holds.
     */
    const stepCount = wf ? wf.steps.length : 1;
    /**
     * The outer bound on the loop, which is now two budgets deep rather than one.
     *
     * Every round the reviewer is entitled to may itself be continued `MAX_AUTO_CONTINUE_ROUNDS`
     * times, so the worst case is the product — not the sum, and certainly not `MAX_REVIEW_ROUNDS`
     * alone. Leaving it at the old value is the subtle version of the bug this whole change is
     * about: auto-continue rounds would silently eat the reviewer's, and a Task that used its
     * continuations early would fall out of the bottom of the loop with nothing recorded and
     * nothing said. It is a sanity bound on a bounded thing, not a second policy — the two budgets
     * below decide what actually happens.
     */
    const maxRounds = MAX_REVIEW_ROUNDS * (1 + MAX_AUTO_CONTINUE_ROUNDS) * Math.max(1, stepCount);

    if (decidedReview) {
      const applied = await applyDecision(
        scope,
        {
          transition,
          worktreeOps,
          repoAdmin,
          repoPath,
          retainedPrimary,
          worktreeBindings,
          upstreamPathFor,
        },
        loop,
        decidedReview,
      );
      if (applied) return applied;
    }

    for (let round = 0; round < maxRounds; round++) {
      /*
       * A round carrying on a truncated conversation is the model's, not the reviewer's: it
       * neither spends `roundsOnStep` nor may be stopped by it. `MAX_AUTO_CONTINUE_ROUNDS` is what
       * bounds it, and it is checked where the decision to continue is made rather than here.
       *
       * With no Workflow and nothing truncated: stepCount 1, `roundsOnStep === round + 1`, and
       * this never fires — rounds 0 to 4 exactly as before. With one: the budget is per Step and
       * resets at every advance, so a Step that exhausts it stops the run rather than the pipeline
       * running on into the next Step with the reviewer's patience already spent.
       */
      // Nor is the retry of a round whose `--resume` found nothing (`resumeLostRetry`): the
      // reviewer has not seen that round either.
      if (!loop.continuingTruncated && !loop.resumeLostRetry) {
        if (loop.roundsOnStep >= MAX_REVIEW_ROUNDS) break;
        loop.roundsOnStep += 1;
      }
      loop.resumeLostRetry = false;
      /*
       * Read once and cleared here, so nothing below can mistake "the round that just started was
       * a continuation" for "the round that just ended asked for one". Run-local rather than
       * durable, and deterministic under replay for the same reason the loop itself is: it is
       * derived only from the memoized results of earlier rounds.
       */
      const continuation = loop.continuingTruncated;
      loop.continuingTruncated = false;
      // Captured, because `leg` is rebound at the next Step boundary while this round's harness
      // may still be reporting its conversation id on a detached chain.
      const roundStepId = loop.leg.stepId;
      const run = await step.run(`agent-run-${round}`, () =>
        runHarnessRound(scope, round, loop, {
          wf,
          executor,
          worktreeOps,
          repoAdmin,
          repoPath,
          primaryBinding,
          provisionedByAttachment,
          worktreeBindings,
          retainedPrimary,
          seed,
          decidedReview,
          continuation,
          roundStepId,
        }),
      );

      // Compaction at a turn boundary (issue #2, AC-3). A long run gets a summary standing in for
      // a closed range of its log; the events in that range are not touched, deleted or rewritten,
      // so replay still reproduces the full history and the review gate keeps its evidence (AC-2,
      // Principle I). The unique `(session_id, from_seq)` index makes a replayed durable step a
      // no-op rather than a duplicate (Principle III).
      await step.run(`compact-${round}`, () => compactSession(db, workspaceId, sessionId));

      if (run.worktree) {
        loop.wt = run.worktree;
        // The audit line binding a worktree to its Task (Principle IV) is emitted on adoption,
        // because that is the first moment SoloW knows which directory the harness used.
        logWorktreeBinding(log, { workspaceId, taskId, worktreePath: run.worktree.path });
        // And the row saying the same thing, for everything that has to answer "does this Task
        // still hold a working copy" without a filesystem to look at — the delete preview and the
        // Issue view both ask, and both read this table. Its own step, so it survives a restart
        // between the run and the gate; idempotent, so a retried round does not double it.
        const adoptedPrimary = run.worktree;
        await step.run(`record-worktree-${round}`, () =>
          recordWorktree(db, workspaceId, {
            taskId,
            repositoryId: primaryBinding.repository.id,
            path: adoptedPrimary.path,
            branch: adoptedPrimary.branch,
          }),
        );
      }

      if (run.kind === "abandoned") {
        // Nothing to record and nothing to review: the Task this run belonged to is gone. The
        // worktree is deliberately left where it is — the delete path owns tearing that down, and
        // guessing at it from a run that has already lost its context is how a directory someone
        // else adopted gets removed.
        return { taskId, result: "abandoned" };
      }

      if (run.kind === "resume-lost") {
        const lostTwice = await restartLostConversation(scope, round, loop);
        if (lostTwice) return lostTwice;
        continue;
      }
      if (run.kind === "failed") {
        if (run.cls === "park") {
          if (await parkRound(scope, round, loop.leg.stepId)) continue;
          // The Task left `parked` while this run slept; whoever moved it owns it now.
          return { taskId, result: "stood_down" };
        }
        // credential_expired or hard failure: pause/stop with the reason preserved. A verdict the
        // transport put in words (a harness below its catalog pin) is the reason itself — "fail"
        // would leave the operator guessing what to upgrade.
        const reason = ("verdict" in run && run.verdict) || run.cls;
        await failRound(scope, round, reason, loop.leg.stepId);
        return { taskId, result: run.cls };
      }

      if (stopReasonMeansTruncated(run.stopReason) && run.outcome === null) {
        if (await continueTruncated(scope, round, loop, run.stopReason)) continue;
      }
      // Whatever happens below, this stretch of work is over. The next one that runs out of budget
      // starts with its own continuations rather than the remains of this one's.
      loop.autoContinues = 0;

      const finished = await finishRound(scope, round, loop, run, {
        transition,
        worktreeOps,
        worktreeBindings,
      });
      if (finished) return finished;
    }

    /*
     * The worktrees are deliberately left where they are (History retention, Decision 0025).
     *
     * This is where the lifecycle used to remove every worktree the Task was given and mark the
     * rows — the tidy ending. It was also the end of the conversation: Claude Code keys a
     * transcript to the directory it ran in, so a Task reopened from History had nowhere to
     * resume into and started again from the brief. The directories now stay for the retention
     * window and the sweep in `retention.ts` removes them, whichever executor made them — the
     * container is disposed below regardless; a Task's private clone on the host is what the
     * next round resumes in.
     *
     * Reached only when the rounds ran out without the harness ever reaching a gate — every
     * other way out of the loop returns. That is a run going round in circles, and it is said
     * rather than reported as `done` over a Task nobody has looked at.
     */
    return await failRun(
      scope,
      "rounds-exhausted",
      "round_budget_exhausted",
      loop.leg.stepId,
      "running",
    );
  } finally {
    /*
     * Tear the execution host down on the way out (issue #96).
     *
     * A `finally` around the whole body rather than a call before each `return`: the lifecycle
     * has ten terminal returns below this point, and per-return disposal is a list nobody keeps
     * complete — the one that gets forgotten is the one that leaks a container.
     *
     * **Not** a `step.run`: a durable dispose is memoized, so the retry that has just rebuilt the
     * container would replay the teardown as already-done and leak the one it is holding. Not
     * durable in any other sense either — Inngest suspends by leaving a step's promise pending
     * and never unwinds this body, so a run cancelled between steps never reaches here at all.
     * That is what the labelled reaper in `executor/reap.ts` is for; this is the fast path, not
     * the net.
     *
     * Swallowed because teardown must not fail a Task that otherwise completed, and a no-op for
     * the local driver, which has nothing to dispose of.
     */
    await executor.dispose().catch((cause) => {
      captureException(log, cause, { stage: "executor-dispose" });
    });
  }
}

export const taskRun = inngest.createFunction(
  {
    id: "task-run",
    retries: TASK_RUN_RETRIES,
    triggers: [{ event: "task.launch.requested" }],
    /**
     * Never two runs working on one Task at the same moment.
     *
     * Two runs on one Task share its worktree, its Session and its harness conversation, and
     * nothing in either can tell the other is there — it was seen as three harnesses running the
     * same Step side by side, each writing the cursor the others read. The start paths refuse a
     * second start in the database (`claimTaskState`, `review.decide`), and a decision is taken up
     * once (`decision-take-up`); this is the engine's half, for whatever reaches it anyway — a
     * reconcile relaunch, a redelivered event. A limit rather than `singleton`: a second run waits
     * its turn and then finds out from the database that it has nothing to do, where cancelling
     * either one could stop a decision half-applied.
     */
    concurrency: [{ key: "event.data.taskId", limit: 1 }],
    /**
     * Cancellation channel for a run the operator wants gone — today, the force delete of the
     * Issue the Task belongs to (`issue.delete` with `force`). Scoped by `taskId` so a stop for
     * one Task never unwinds another's run.
     *
     * Inngest cancels *between* steps, so this is not instantaneous: the current step finishes,
     * then the run stops. That is why the deleting side re-checks Task state inside its own
     * transaction instead of treating the accepted stop as proof the harness is already gone.
     */
    cancelOn: [{ event: "task.stop.requested", if: "async.data.taskId == event.data.taskId" }],
  },
  (args) => runTaskLifecycle(defaultDeps(), args as unknown as TaskRunArgs),
);
