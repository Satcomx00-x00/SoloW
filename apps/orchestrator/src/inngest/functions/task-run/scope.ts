import type { TaskState } from "@solow/contracts";
import type { Db } from "@solow/db";
import { captureException, type Logger } from "@solow/observability";
import {
  appendSessionEvent,
  latestStateTransition,
  nextSessionEventSeq,
  type TaskRunContext,
} from "../../../data.js";
import type { StepLike, TaskRunDeps } from "./types.js";

/**
 * What every part of one run shares: who it is for, where it reports, and the two ways it
 * tells the world a Task moved.
 *
 * Built once per run by `runTaskLifecycle`, after `load`, and handed to each part rather than
 * closed over, so a part can be driven on its own with a scope a test builds.
 */
export interface RunScope {
  deps: TaskRunDeps;
  db: Db;
  step: StepLike;
  log: Logger;
  workspaceId: string;
  taskId: string;
  sessionId: string;
  ctx: TaskRunContext;
  /** The Task's own channel — the Task page subscribes to it. */
  channel: string;
  /** The Workspace's board channel. */
  boardChannel: string;
  announce: (state: TaskState) => void;
  recordTransition: (
    from: TaskState,
    to: TaskState,
    workflowStepId: string | null,
    reason?: string,
  ) => Promise<void>;
}

export function createRunScope(base: {
  deps: TaskRunDeps;
  step: StepLike;
  log: Logger;
  workspaceId: string;
  taskId: string;
  sessionId: string;
  ctx: TaskRunContext;
}): RunScope {
  const { deps, log, workspaceId, taskId, sessionId } = base;
  const { db } = deps;

  const channel = deps.hub.taskChannel(workspaceId, taskId);
  const boardChannel = deps.hub.boardChannel(workspaceId);

  /**
   * Announce a Task state change to everyone watching it.
   *
   * Both channels, and the second one is the bug this replaces. It published to the board channel
   * alone, on the reasoning that the board is what shows Task states — but the Task page shows
   * one too, and it subscribes to the *task* channel. So a run that finished, failed or parked
   * updated the board instantly and left the page dedicated to that very Task claiming the harness
   * was still writing, until somebody reloaded. Every `diff` on the line below already went to
   * both; the status was the one that did not.
   *
   * Published twice rather than having the page subscribe to the board channel as well: a Task
   * page would then receive every state change in the Workspace and filter for its own, which is
   * a subscription to other people's work in order to learn about your own.
   */
  const announce = (state: TaskState) => {
    const message = { kind: "status" as const, taskId, state, at: new Date().toISOString() };
    deps.hub.publish(boardChannel, message);
    deps.hub.publish(channel, message);
  };

  /**
   * Record a transition in the session log as well as announcing it (issue #2).
   *
   * Three audiences, one fact, and only one durable home: the board publish is ephemeral
   * transport, `logStateTransition` is operational and rotates, and this is the *record* — what a
   * reviewer reads afterwards to understand why the transcript has the shape it has, and what a
   * snapshot carries (Principle I). The sequence is read back from the database rather than taken
   * from the run's in-memory counter, because transitions happen outside the durable step that
   * counter lives in — the same pattern the diff capture below already uses. Every call site is
   * *inside* the durable step that applies the transition, so an Inngest replay after a restart
   * re-records nothing (Principle III); calling it beside the step instead would append a second
   * copy on every retry. Failure to record is swallowed: a Task must not fail because its
   * narration did not land.
   */
  const recordTransition = async (
    from: TaskState,
    to: TaskState,
    /**
     * The Workflow Step in force when the Task moved, or null for a Task on no Workflow.
     *
     * Passed at every call site rather than read from a variable this helper closes over, and
     * that is not fastidiousness: `recordTransition` is defined before the run has resolved a
     * Step at all — the first transitions it writes are entry failures — while `leg`, the run
     * loop's own binding, is rebound in place at each Step boundary and does not exist in this
     * scope. A captured copy would therefore be either unreachable or a second, staler answer to
     * a question `leg` already answers. Naming it here makes each call state which Step its
     * transition belongs to, and the compiler ask.
     */
    workflowStepId: string | null,
    reason?: string,
  ) => {
    try {
      // `seq` is read back as max+1, so the `(session_id, seq)` unique index cannot make a
      // second attempt a no-op the way it does for the harness's own events — a retry would simply
      // land at a new seq. Inngest retries a step *body* from the top when anything in it
      // throws, and every call site here is followed by more work that can (the session write,
      // the diff capture, the publish), so the guard is the log itself: an identical transition
      // already at the head of the state records is this same transition being replayed. Two
      // genuinely identical transitions can never be adjacent, because reaching a state twice
      // means leaving it in between and that departure is recorded too.
      const previous = await latestStateTransition(db, workspaceId, sessionId);
      const same =
        previous?.from === from &&
        previous?.to === to &&
        // Normalised on both sides: an empty reason is not written, so it reads back as absent.
        (previous?.reason ?? "") === (reason ?? "");
      if (previous && same) return;
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        workflowStepId,
        payload: { kind: "state", from, to, ...(reason ? { reason } : {}) },
      });
    } catch (cause) {
      captureException(log, cause, { stage: "session-state-record" });
    }
  };

  return { ...base, db, channel, boardChannel, announce, recordTransition };
}
