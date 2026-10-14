import type { HarnessStopReason, SessionEventPayload } from "@solow/contracts";
import {
  appendSessionEvent,
  forgetHarnessConversations,
  nextSessionEventSeq,
} from "../../../data.js";
import { toTaskEvent } from "../../../ws/replay.js";
import type { RunScope } from "./scope.js";
import { failRun } from "./terminal.js";
import type { LoopState } from "./types.js";

/*
 * The run loop's two round budgets — the reviewer's and the model's — and the two ways a round
 * is run again without a reviewer having seen it: a lost conversation retried from the brief, and
 * a truncated one carried on.
 */

export const MAX_REVIEW_ROUNDS = 5;

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
export const MAX_AUTO_CONTINUE_ROUNDS = 3;

/**
 * Run the round again from the brief after its `--resume` found no conversation.
 *
 * Returns the run's terminal result when this has already happened once in this run, and null
 * when the loop should go round again.
 */
export async function restartLostConversation(
  scope: RunScope,
  round: number,
  loop: LoopState,
): Promise<{ taskId: string; result: string } | null> {
  const { deps, step, db, workspaceId, taskId, sessionId, channel } = scope;
  /*
   * The conversation this round tried to carry on is gone. Once: the ids are forgotten, the
   * operator is told, and the same round is run again from the brief in the same worktree.
   * A second such failure means something else is wrong, and is filed as one.
   */
  if (loop.resumeLost) {
    return await failRun(scope, `resume-lost-twice-${round}`, "fail", loop.leg.stepId, "running");
  }
  loop.resumeLost = true;
  loop.resumeLostRetry = true;
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
      workflowStepId: loop.leg.stepId,
      payload,
    });
    const frame = toTaskEvent(payload, taskId, sessionId, seq, loop.leg.stepId);
    if (frame) deps.hub.publish(channel, frame);
  });
  return null;
}

/**
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
export async function continueTruncated(
  scope: RunScope,
  round: number,
  loop: LoopState,
  stopReason: HarnessStopReason,
): Promise<boolean> {
  const { deps, step, db, workspaceId, taskId, sessionId, channel } = scope;
  const spent = loop.autoContinues >= MAX_AUTO_CONTINUE_ROUNDS;
  // The word the harness would use for what it ran out of. `max_tokens` is a full context,
  // not a spent turn allowance, and telling an operator the wrong one sends them looking at
  // the wrong setting.
  const budget = stopReason === "max_tokens" ? "context budget" : "turn budget";
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
        : `The harness hit its ${budget} with work still to do, so this run is continuing the same conversation instead of sending it for review (continuation ${loop.autoContinues + 1} of ${MAX_AUTO_CONTINUE_ROUNDS}).`,
    };
    const seq = await nextSessionEventSeq(db, workspaceId, sessionId);
    await appendSessionEvent(db, workspaceId, {
      sessionId,
      seq,
      workflowStepId: loop.leg.stepId,
      payload,
    });
    const frame = toTaskEvent(payload, taskId, sessionId, seq, loop.leg.stepId);
    if (frame) deps.hub.publish(channel, frame);
  });
  if (!spent) {
    loop.autoContinues += 1;
    loop.continuingTruncated = true;
    return true;
  }
  // Budget spent: fall through to exactly the path a finished round takes. Never a throw and
  // never a stall — the operator gets the work, the declaration `to-review` writes for it,
  // and the notice above saying why it is only this far along (a legible outcome they can
  // act on: approve what is there, or send it back for another five rounds of their own).
  return false;
}
