import {
  reviewDecisionSchema,
  type SessionEventPayload,
  stopReasonMeansTruncated,
} from "@solow/contracts";
import { handoffWith, reopenAfterApplyingDecisions, stepCanEndWorkflow } from "@solow/core";
import { createDb } from "@solow/db";
import {
  captureException,
  createLogger,
  logStateTransition,
  logWorktreeBinding,
  withRunContext,
} from "@solow/observability";
import { z } from "zod";
import {
  appendSessionEvent,
  compactSession,
  forgetHarnessConversations,
  loadTaskRunContext,
  nextSessionEventSeq,
  recordTaskCompletion,
  recordWorktree,
  setSessionState,
  setTaskState,
  takeUpReviewDecision,
} from "../../data.js";
import { orchestratorEnv } from "../../env.js";
import { createExecutorFor, probeExecutorFor } from "../../executor/factory.js";
import { harnessRegistry } from "../../harness/registry.js";
import type { HarnessRunner } from "../../harness/runner.js";
import { createHarnessRunner } from "../../harness/runners.js";
import {
  adoptWorktree,
  cleanupWorktree,
  commitWorktree,
  diffWorktree,
  discardWorktreeChanges,
  hasChanges,
  prepareRepository,
  provisionWorktree,
  publishWorktreeBranch,
  pushWorktreeBranch,
  type Worktree,
} from "../../worktree/manager.js";
import { seedSetupFiles } from "../../worktree/setup-files.js";
import { hub } from "../../ws/hub.js";
import { toTaskEvent } from "../../ws/replay.js";
import { inngest } from "../client.js";
import { reportStepFinished, type StepTransition, takeAdvance } from "./task-run/advance.js";
import { applyDecision } from "./task-run/decision.js";
import { prepareWorkspace, resolveEntry, TASK_RUN_RETRIES } from "./task-run/prepare.js";
import { runHarnessRound } from "./task-run/round.js";
import { createRunScope } from "./task-run/scope.js";
import { failRound, failRun, parkRound } from "./task-run/terminal.js";
import {
  type LoopState,
  patternsFor,
  type TaskRunArgs,
  type TaskRunDeps,
} from "./task-run/types.js";

export {
  type BriefContinuation,
  type BriefWorkspace,
  harnessBrief,
  widgetAnswerMessage,
} from "./task-run/brief.js";
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

const MAX_REVIEW_ROUNDS = 5;

/**
 * How many extra rounds a harness may have to carry on a conversation its own budget cut short.
 *
 * A separate budget from `MAX_REVIEW_ROUNDS` because it answers a different question.
 * `roundsOnStep` is the *reviewer's* patience: how many times a person is willing to send work
 * back before the run gives up on them. This is the *model's*: how many times a harness that ran
 * out of turns or context mid-task may pick the same conversation up and keep going. Spending one
 * out of the other is how a Task that simply had a lot to do arrives at review with the reviewer's
 * rounds already gone, and how a Task the reviewer keeps rejecting quietly gets extra attempts.
 *
 * Three. One is not a budget — a harness that hits `max_turns` has usually only just started, and
 * the first continuation is the ordinary case this whole mechanism exists for. Ten would let a
 * `max_tokens` stop — a conversation whose context is genuinely full, and which will therefore
 * truncate again a few turns after every resume — spend the run going round in a circle nobody is
 * watching. Three is enough for a long job to finish and few enough that a conversation which is
 * not converging reaches a person while there is still something for them to decide.
 *
 * Exhausting it is not a failure and never throws: the round falls through to exactly the path a
 * finished round takes, with a notice saying the budget was spent, so the operator is given the
 * work and the reason rather than a stall.
 */
const MAX_AUTO_CONTINUE_ROUNDS = 3;

/** Production wiring. */
export function defaultDeps(): TaskRunDeps {
  const env = orchestratorEnv();
  return {
    db: createDb(),
    // The executor is no longer built here (issue #96). It cannot be: the Executor Profile
    // belongs to the Task, and no Task exists yet at this point — which is exactly why every
    // consumer below now takes one rather than closing over one.
    executorFor: createExecutorFor,
    preflight: probeExecutorFor,
    runner: (protocol, settings, executor) =>
      createHarnessRunner(protocol, {
        executor,
        permissionMode: settings.permissionMode,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.modeId ? { modeId: settings.modeId } : {}),
        ...(settings.checkpoints ? { checkpoints: settings.checkpoints } : {}),
        ...(settings.version ? { version: settings.version } : {}),
        ...(settings.autoApprove ? { autoApprove: true } : {}),
        unattendedPermissionPosture: env.SOLOW_ACP_UNATTENDED_PERMISSION,
      }),
    worktreeRoot: env.SOLOW_WORKTREE_ROOT,
    repoCacheRoot: env.SOLOW_REPO_CACHE_ROOT,
    logger: createLogger({ service: "orchestrator" }),
    worktree: (executor) => ({
      prepare: (params) => prepareRepository(executor, params),
      provision: (params) => provisionWorktree(executor, params),
      adopt: (repoPath, reportedPath) => adoptWorktree(executor, repoPath, reportedPath),
      seed: (params) => seedSetupFiles(executor, params),
      commit: (path, message, patterns) => commitWorktree(executor, path, message, patterns),
      discard: (path) => discardWorktreeChanges(executor, path),
      publish: (repoPath, upstreamPath, branch) =>
        publishWorktreeBranch(executor, repoPath, upstreamPath, branch),
      push: (upstreamPath, remoteUrl, branch, credential) =>
        pushWorktreeBranch(executor, upstreamPath, remoteUrl, branch, credential),
      cleanup: (repoPath, worktree, ownRepository) =>
        cleanupWorktree(executor, repoPath, worktree, { ownRepository }),
      hasChanges: (path, patterns) => hasChanges(executor, path, patterns),
      diff: (path, patterns) => diffWorktree(executor, path, patterns),
    }),
    hub,
    registry: harnessRegistry,
  };
}

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
  const { channel, announce, recordTransition } = scope;

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

    /**
     * The worktree every later step — diff, commit, discard, cleanup — acts on. Read back from
     * the harness (Claude Code makes its own) or set from what SoloW provisioned (ACP), and
     * confirmed with git either way before anything is written into it.
     */
    let wt: Worktree | null = provisioned;

    /** Feedback from the previous review round; it becomes the next round's brief. */
    let pendingFeedback: string | undefined;
    /**
     * The decisions a reviewer settled when approving this Step, while the harness applies them.
     *
     * Approving a Step whose harness asked decisions does not move the Workflow on at once. The
     * reviewer's answers are instructions to *this* Step's harness — a choice it made may have
     * been overturned, and the spec or plan it wrote still says otherwise — so the harness gets
     * one more round on the same Step to bring its work in line, and the approval is spent only
     * once that round has finished. Moving on at the click handed the next Step work that did not
     * yet reflect the answers it was being briefed with.
     *
     * Set by the approval, read by the round it starts (its brief) and by that round's end (the
     * advance), cleared there and at every Step boundary.
     */
    let applyingDecisions: string | null = null;

    /**
     * The harness binding and brief this round runs under (issue #5, AC-3).
     *
     * `let`, and so is the runner beside it — that pair is the whole of what a Step boundary
     * changes. Everything else the loop touches is per *round*, which is why there is no nested
     * Step loop: a nested one would reset `round` and Inngest would hand Step 2 back Step 1's
     * memoized `agent-run-0` and `approve-0`, silently skipping Step 2's harness run and replaying
     * Step 1's review decision. A monotonic counter makes that impossible to write.
     */
    let leg = entryLeg;
    let runner: HarnessRunner = entryRunner;
    /**
     * How many rounds this Step has had. `MAX_REVIEW_ROUNDS` is per Step, not per run: a
     * five-Step pipeline that spent its whole budget on Step 1 would otherwise reach Step 2 with
     * no rounds left and stop without saying why.
     */
    let roundsOnStep = 0;
    /**
     * How many rounds this Step has spent carrying on a conversation the harness's own budget cut
     * short, since the last round a reviewer was shown (`MAX_AUTO_CONTINUE_ROUNDS`).
     *
     * Reset wherever `roundsOnStep` is — at a Step boundary — and also on any round that does not
     * auto-continue: reaching the review gate is the harness having finished a stretch of work,
     * and the next stretch starts with its own budget rather than the remains of the last one's.
     */
    let autoContinues = 0;
    /**
     * Whether the round about to start is one of those, rather than one the reviewer asked for.
     *
     * A flag rather than a comparison against `autoContinues`, because the loop has to answer two
     * different questions from it: whether to spend one of the reviewer's rounds (it must not),
     * and what to tell the harness about why it is being started again.
     */
    let continuingTruncated = false;
    /**
     * The round about to start follows one whose `--resume` named a conversation the harness no
     * longer has (history: a transcript purged, or its worktree gone). Set once per run — the
     * second such failure is a real one — and what keeps the retry from asking to resume again.
     */
    let resumeLost = false;
    /** The very next round is that retry, and does not spend a reviewer's round. */
    let resumeLostRetry = false;

    /**
     * The loop's bindings as the parts that read or rebind them see them — accessors rather than
     * a copy, so a part and the loop can never disagree about which Step is in force.
     */
    const loop: LoopState = {
      get wt() {
        return wt;
      },
      set wt(value) {
        wt = value;
      },
      get leg() {
        return leg;
      },
      set leg(value) {
        leg = value;
      },
      get runner() {
        return runner;
      },
      set runner(value) {
        runner = value;
      },
      get roundsOnStep() {
        return roundsOnStep;
      },
      set roundsOnStep(value) {
        roundsOnStep = value;
      },
      get autoContinues() {
        return autoContinues;
      },
      set autoContinues(value) {
        autoContinues = value;
      },
      get continuingTruncated() {
        return continuingTruncated;
      },
      set continuingTruncated(value) {
        continuingTruncated = value;
      },
      get pendingFeedback() {
        return pendingFeedback;
      },
      set pendingFeedback(value) {
        pendingFeedback = value;
      },
      get resumeLost() {
        return resumeLost;
      },
      set resumeLost(value) {
        resumeLost = value;
      },
      get resumeLostRetry() {
        return resumeLostRetry;
      },
      set resumeLostRetry(value) {
        resumeLostRetry = value;
      },
      get applyingDecisions() {
        return applyingDecisions;
      },
      set applyingDecisions(value) {
        applyingDecisions = value;
      },
    };
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
      if (!continuingTruncated && !resumeLostRetry) {
        if (roundsOnStep >= MAX_REVIEW_ROUNDS) break;
        roundsOnStep += 1;
      }
      resumeLostRetry = false;
      /*
       * Read once and cleared here, so nothing below can mistake "the round that just started was
       * a continuation" for "the round that just ended asked for one". Run-local rather than
       * durable, and deterministic under replay for the same reason the loop itself is: it is
       * derived only from the memoized results of earlier rounds.
       */
      const continuation = continuingTruncated;
      continuingTruncated = false;
      // Captured, because `leg` is rebound at the next Step boundary while this round's harness
      // may still be reporting its conversation id on a detached chain.
      const roundStepId = leg.stepId;
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
        wt = run.worktree;
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
        /*
         * The conversation this round tried to carry on is gone. Once: the ids are forgotten, the
         * operator is told, and the same round is run again from the brief in the same worktree.
         * A second such failure means something else is wrong, and is filed as one.
         */
        if (resumeLost) {
          return await failRun(scope, `resume-lost-twice-${round}`, "fail", leg.stepId, "running");
        }
        resumeLost = true;
        resumeLostRetry = true;
        await step.run(`resume-lost-${round}`, async () => {
          await forgetHarnessConversations(db, workspaceId, taskId);
          const payload: SessionEventPayload = {
            kind: "notice",
            text: "The previous conversation could not be found, so this run is starting again from the brief in the same worktree.",
          };
          const seq = await nextSessionEventSeq(db, workspaceId, sessionId);
          await appendSessionEvent(db, workspaceId, {
            sessionId,
            seq,
            workflowStepId: leg.stepId,
            payload,
          });
          const frame = toTaskEvent(payload, taskId, sessionId, seq, leg.stepId);
          if (frame) deps.hub.publish(channel, frame);
        });
        continue;
      }
      if (run.kind === "failed") {
        if (run.cls === "park") {
          await parkRound(scope, round, leg.stepId);
          continue;
        }
        // credential_expired or hard failure: pause/stop with the reason preserved. A verdict the
        // transport put in words (a harness below its catalog pin) is the reason itself — "fail"
        // would leave the operator guessing what to upgrade.
        const reason = ("verdict" in run && run.verdict) || run.cls;
        await failRound(scope, round, reason, leg.stepId);
        return { taskId, result: run.cls };
      }

      /*
       * The harness ran out; it did not finish. So the run gives it more rather than presenting a
       * half-done change to a reviewer as "changes ready".
       *
       * Both halves of the condition carry weight. `stopReasonMeansTruncated` is the *process*
       * saying it hit a turn or token budget with work still to do; `run.outcome === null` is the
       * *harness* never having declared a `task_complete`. A harness that declared and then hit a
       * budget has said what it thinks it did, and that declaration belongs to the operator —
       * only a round that ran out with nothing to say for itself is one this run may continue on
       * its own authority. That pairing is the disagreement `agent_done` records and this is the
       * one place that acts on it.
       *
       * Nothing is recorded and nothing moves: no completion row, no `awaiting_review`, no
       * gate. The Task stays `running`, the worktrees stay where they are, and the next
       * round picks the same conversation back up — `harness_session_id` was written mid-run by
       * the round that just stopped, so `resolveResumeHarnessSessionId` finds it with no extra
       * plumbing and the brief becomes "carry straight on" rather than the whole thing again.
       */
      if (stopReasonMeansTruncated(run.stopReason) && run.outcome === null) {
        const spent = autoContinues >= MAX_AUTO_CONTINUE_ROUNDS;
        // The word the harness would use for what it ran out of. `max_tokens` is a full context,
        // not a spent turn allowance, and telling an operator the wrong one sends them looking at
        // the wrong setting.
        const budget = run.stopReason === "max_tokens" ? "context budget" : "turn budget";
        /*
         * One step id for both outcomes, because exactly one of them fires per round — which is
         * what keeps the `agent-run-N` / `auto-continue-N` / `to-review-N` sequence identical on
         * every replay of the same history. Published as well as appended: an operator watching
         * live must see "the harness hit its budget; continuing" at the moment it happens, not a
         * mysterious second round with the explanation waiting for them on a reconnect.
         */
        await step.run(`auto-continue-${round}`, async () => {
          const payload: SessionEventPayload = {
            kind: "notice",
            text: spent
              ? `The harness hit its ${budget} again after ${MAX_AUTO_CONTINUE_ROUNDS} continuations. This run has stopped continuing it and is putting the work in front of you as it stands — it is unfinished, whatever the summary says.`
              : `The harness hit its ${budget} with work still to do, so this run is continuing the same conversation instead of sending it for review (continuation ${autoContinues + 1} of ${MAX_AUTO_CONTINUE_ROUNDS}).`,
          };
          const seq = await nextSessionEventSeq(db, workspaceId, sessionId);
          await appendSessionEvent(db, workspaceId, {
            sessionId,
            seq,
            workflowStepId: leg.stepId,
            payload,
          });
          const frame = toTaskEvent(payload, taskId, sessionId, seq, leg.stepId);
          if (frame) deps.hub.publish(channel, frame);
        });
        if (!spent) {
          autoContinues += 1;
          continuingTruncated = true;
          continue;
        }
        // Budget spent: fall through to exactly the path a finished round takes. Never a throw and
        // never a stall — the operator gets the work, the declaration `to-review` writes for it,
        // and the notice above saying why it is only this far along (a legible outcome they can
        // act on: approve what is there, or send it back for another five rounds of their own).
      }
      // Whatever happens below, this stretch of work is over. The next one that runs out of budget
      // starts with its own continuations rather than the remains of this one's.
      autoContinues = 0;

      /*
       * The harness has finished. It does not follow that the Task is in review.
       *
       * This step used to move it there itself, which made the review gate something that happened
       * *to* an operator rather than something they opened — and made "the harness stopped" and "the
       * work is ready" the same event, which they are not: a harness stops when it runs out of
       * things to do, when it runs out of context, and when it decides the brief was already
       * satisfied. Only one of those is worth a person's attention, and only the harness knows which.
       *
       * So the run records the declaration and the change, and stops. The Task stays where it is,
       * the board shows it as finished, and the transition into `review` is the operator's click —
       * one action, theirs (Principle I is a gate for a human to open, not a conveyor).
       */
      const worktree = run.worktree;
      const gate = worktreeBindings(worktree);
      await step.run(`to-review-${round}`, async () => {
        await recordTaskCompletion(db, workspaceId, taskId, {
          // `changes_ready` when the harness said nothing: it stopped having produced a run, and the
          // conservative reading is the one that puts the work in front of a person rather than
          // the one that quietly files it as "nothing to see".
          outcome: run.outcome ?? "changes_ready",
          summary: run.summary ?? null,
          at: new Date().toISOString(),
        });
        await setSessionState(db, workspaceId, sessionId, "awaiting_review", {
          diffRef: worktree.branch,
        });

        // Capture the change now, while the worktrees still exist: approving removes them, and a
        // reviewer looking at a finished Task should still be able to see what they approved.
        // A capture failure must not block the review gate — the branch name alone is enough to
        // decide on, so this degrades to "no diff shown" rather than stalling the Task.
        //
        // One event per worktree, each naming its Repository (issue #7 AC-4). A Task spanning two
        // repositories produces two changes on two branches, and a reviewer shown one flat file
        // list could not tell which repository a path came from. One repository failing to capture
        // costs only its own group, not the others'.
        for (const entry of gate) {
          try {
            const captured = await worktreeOps.diff(entry.worktree.path, patternsFor(entry));
            await appendSessionEvent(db, workspaceId, {
              sessionId,
              seq: await nextSessionEventSeq(db, workspaceId, sessionId),
              workflowStepId: leg.stepId,
              payload: {
                kind: "diff",
                diffRef: entry.worktree.branch,
                repositoryId: entry.binding.repository.id,
                repositoryName: entry.binding.repository.name,
                ...captured,
              },
            });
          } catch (cause) {
            captureException(log, cause, { stage: "diff-capture" });
          }
        }

        deps.hub.publish(channel, { kind: "diff", taskId, sessionId, diffRef: worktree.branch });
      });
      // The board still has to hear about it — the card's "finished" control appears on this, and
      // the Task's state has not changed to carry the news for it.
      announce("running");

      /*
       * The harness has finished, and on an `agent-signal` Step that is the signal the Step
       * advances on (AC-2). Reported here, and the placement is load-bearing:
       *
       * **After `to-review-${round}`, never before it.** `to-review` is what writes the `diff`
       * session events, and `taskHasRecordedChanges` corroborates the `producedChanges` claim
       * against exactly those events. Move this call above it and the corroborating scan finds
       * nothing, so an `auto-unless-changes` gate opens on the harness's unverified word about its
       * own output — which is the party the gate exists to catch.
       *
       * **Before the gate,** because an `auto` Step must not need a human at all.
       */
      /*
       * The round that applied a reviewer's decisions has ended: spend the approval it was started
       * by, and move on — unless there is a reason a person has to look again first.
       *
       * Three reasons, each a gate reopened on the same Step rather than an advance:
       *
       * - The harness asked new decisions while applying the old ones. Those are as unconfirmed
       *   as the first ones were, and confirming them is the whole point of the gate.
       * - The harness gave up (`blocked`). There is nothing finished to move on from.
       * - This Step can end the Workflow. Ending it integrates, and integration happens only on an
       *   approval of the work being integrated (Principle I) — this round's work has not been
       *   seen by anyone yet. One more click on the last Step is the price of never committing a
       *   change nobody looked at.
       *
       * `holdForReview` keeps the `agent-signal` advance below from spending the same approval in
       * any of those cases: the decision row the reviewer wrote is still unspent until the cursor
       * moves, so that call would otherwise carry the Step past the gate this block just kept.
       */
      let holdForReview = false;
      if (applyingDecisions !== null) {
        const settled = applyingDecisions;
        applyingDecisions = null;
        const stepId = leg.stepId;
        const canEnd = !wf || !stepId || stepCanEndWorkflow(wf.steps, stepId);
        const reopenBecause = reopenAfterApplyingDecisions({
          askedDecisions: run.askedDecisions,
          outcome: run.outcome,
          canEnd,
        });
        if (wf && stepId && leg.advanceOn && run.outcome !== "blocked" && reopenBecause === null) {
          // What the next Step is briefed with: this round's summary — the work *after* the
          // answers — and the answers themselves, so it is told what was settled either way.
          const carried = handoffWith(run.summary, settled);
          const reported = await reportStepFinished(
            scope,
            wf,
            `workflow-applied-${round}`,
            `workflow-recheck-applied-${round}`,
            {
              fromStepId: stepId,
              signal: leg.advanceOn,
              producedChanges: run.outcome === "changes_ready",
              ...(carried ? { handoff: carried } : {}),
              ...(run.outcome ? { outcome: run.outcome } : {}),
            },
          );
          if (reported.kind === "failed") {
            return await failRun(
              scope,
              `workflow-advance-failed-${round}`,
              "workflow_advance_failed",
              stepId,
              "running",
            );
          }
          if (reported.kind === "advanced") {
            const terminal = await takeAdvance(scope, transition, loop, round, reported);
            if (terminal) return terminal;
            continue;
          }
          // Not advanced by the Step's own rule (`held`, `awaiting-decision`): the gate below
          // opens, which is the conservative reading — nothing moves on without a decision.
          holdForReview = true;
        } else {
          holdForReview = true;
          if (reopenBecause !== null && stepId) {
            await step.run(`decisions-reopened-${round}`, async () => {
              await appendSessionEvent(db, workspaceId, {
                sessionId,
                seq: await nextSessionEventSeq(db, workspaceId, sessionId),
                workflowStepId: stepId,
                payload: {
                  kind: "notice",
                  text:
                    reopenBecause === "new-decisions"
                      ? "Applying your decisions raised new ones. Confirm them, then approve again to move on."
                      : "Your decisions are applied. This step can end the workflow, so nothing is integrated until you approve the result.",
                },
              });
            });
          }
        }
      }

      if (wf && leg.advanceOn === "agent-signal" && leg.stepId && !holdForReview) {
        const reported = await reportStepFinished(
          scope,
          wf,
          `workflow-signal-${round}`,
          `workflow-recheck-${round}`,
          {
            fromStepId: leg.stepId,
            signal: "agent-signal",
            producedChanges: run.outcome === "changes_ready",
            ...(run.summary ? { handoff: run.summary } : {}),
            ...(run.outcome ? { outcome: run.outcome } : {}),
          },
        );
        if (reported.kind === "failed") {
          return await failRun(
            scope,
            `workflow-advance-failed-${round}`,
            "workflow_advance_failed",
            leg.stepId,
            "running",
          );
        }
        if (reported.kind === "advanced") {
          const terminal = await takeAdvance(scope, transition, loop, round, reported);
          if (terminal) return terminal;
          continue;
        }
        /*
         * `completed` here means the *last* Step signalled and an unspent approval was found —
         * and it deliberately does not integrate. Integration keeps exactly one home in this
         * file, inside `decision-approve`, reachable only from a run started by an `approve`
         * decision. Falling through to the gate costs one extra approval in a rare state, which
         * is stricter than Principle I requires and never looser.
         *
         * `awaiting-decision` and `held` fall through for the ordinary reason: the cursor did not
         * move and a person has to look. The Step's summary is parked in
         * `workflow_pending_handoff`, which is the column's whole purpose — the run that
         * applies the decision is a different run, and has only the database to read them from.
         */
      }

      /*
       * Under a Workflow, the run opens the gate itself (F03 FR-10: "when a Run reaches a Gate, it
       * pauses and requests the required human decision").
       *
       * The rule above — the transition into `review` is the operator's click — is about a Task
       * on no Workflow, where "the harness stopped" and "someone should look" are different facts
       * and only the person can tell which. Here they are the same fact: the only way past this
       * point is a decision, so a Task left `running` with an "Open review" button is a
       * gate the person has to open before they can answer it. A plan-first Step showed the cost
       * in full — its harness declares `nothing_to_do` every time, and the operator was left
       * looking at "Finished — nothing to do" with the Approve they needed one click further away.
       *
       * Not for a harness that gave up: `blocked` has not reached the gate, and a review over an
       * abandoned run asks a person to sign off on nothing — the same line `canOpenReview` draws.
       * Idempotent on a redrive: `setTaskState` writes the same value and `recordTransition`
       * drops an identical adjacent transition.
       *
       * `failureReason: null` because a gate this run has just opened is a live one — whatever an
       * earlier round left on the row is overtaken. Kept, a `review_decision_not_applied` from
       * before a Retry made this gate read as dead: the page offered Retry instead of Approve.
       */
      if (wf && leg.stepId && run.outcome !== "blocked") {
        const stepId = leg.stepId;
        await step.run(`open-gate-${round}`, async () => {
          await setTaskState(db, workspaceId, taskId, "review", { failureReason: null });
          await recordTransition("running", "review", stepId);
        });
        logStateTransition(log, { workspaceId, taskId, from: "running", to: "review" });
        announce("review");
      }

      /*
       * The gate is open, and the run ends here.
       *
       * The decision is not waited for. It is a row someone writes later, and `review.decide`
       * starts the next run with it (see `launchData`); that run applies it before anything else.
       * Ending is what makes a decision impossible to lose: there is no parked run to go missing,
       * and the executor this run holds is released instead of sitting idle behind a person.
       */
      return { taskId, result: "awaiting_review" };
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
      leg.stepId,
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
