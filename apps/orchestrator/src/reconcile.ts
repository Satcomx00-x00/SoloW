import type { TaskCompletionOutcome } from "@gatecontrol/contracts";
import { parseSessionEventPayload } from "@gatecontrol/contracts";
import { INTERRUPTED_REASON } from "@gatecontrol/core";
import { type Db, session, sessionEvent, task } from "@gatecontrol/db";
import { and, desc, eq, ne } from "drizzle-orm";
import type { AgentRegistry } from "./agent/registry.js";
import {
  appendSessionEvent,
  nextSessionEventSeq,
  recordTaskCompletion,
  setSessionState,
  setTaskState,
} from "./data.js";
import type { EventHub } from "./ws/hub.js";

/**
 * Reclaim a Task left `running` by a process that is provably gone (reported directly: an Owner
 * watching a Task's input answer "No agent is running" forever after an orchestrator restart).
 *
 * `running` is *supposed* to mean "the durable workflow's `agent-run` step is either executing or
 * about to be redriven" — Inngest retries an incomplete step from the top, so a genuine restart
 * ordinarily heals itself the moment the workflow resumes and registers again with
 * `agentRegistry` (see that module's own doc comment). This function exists for the case that
 * doesn't heal: the Inngest server itself lost the in-flight run (its dev server is in-memory
 * only, and a hosted deployment can still drop a run past its retry budget), and nothing will
 * ever redrive it. Left alone, the Task stays `running` — and every input the Owner sends
 * bounces off an empty registry — forever.
 *
 * Called on a timer for the life of the process, not once at boot — and the difference is the
 * whole of a reported incident. The sweep used to be a single `setTimeout` twenty seconds after
 * start-up, which answers exactly one shape of failure: a Task already orphaned by the *previous*
 * process. A Task orphaned *later* was never looked at again. That is what happened: an
 * orchestrator booted at 11:52, swept at 11:52:37 and correctly left a Task alone because its run
 * was genuinely alive and registered; that run then died at 13:54 with its last turn written and
 * its work committed, and the Task sat in `running` — its input box answering "No agent is
 * running" — for the hour and a half until an Owner came asking. The net was real, and it had
 * already been used up before the fall.
 *
 * Two independent signals have to agree before anything is reclaimed, because a periodic sweep
 * can catch a healthy run in a way a boot-time one cannot:
 *
 * 1. **Not in `agentRegistry`.** Registration spans the whole `agent-run` step, so a live agent —
 *    including one sitting inside a twenty-minute build — is always present. This is conclusive
 *    when it is true.
 * 2. **Silent for `RECLAIM_STALE_MS`.** The registry is empty in the gaps *between* durable steps
 *    too — the moment after `agent-run` returns and before `to-review` commits is exactly such a
 *    gap, and it is milliseconds wide in the happy path. Reclaiming there would kill a run that
 *    was about to finish. So a Task is only orphaned once its Session has also produced nothing
 *    for long enough that no ordinary gap could explain it.
 *
 * Together they cannot rule out every false positive — a redrive that stalls for longer than the
 * window and then resumes would be reclaimed — but the alternative (a Task stuck showing
 * "running" with no way to act on it) is strictly worse, and reclaiming always leaves a one-click
 * Retry, never data loss: the worktree and its commits are untouched.
 */

/**
 * How quiet a `running` Task has to have gone before the sweep will call it orphaned.
 *
 * Sized against the widest legitimate gap between two durable steps, not against how long a tool
 * call takes — a long tool call happens *inside* `agent-run`, where the registry check settles it
 * first. Ten minutes is far beyond any observed step scheduling delay and still bounds how long
 * an Owner stares at a dead Task.
 */
export const RECLAIM_STALE_MS = 10 * 60 * 1000;
export async function reclaimOrphanedRuns(
  db: Db,
  registry: Pick<AgentRegistry, "get">,
  hub: Pick<EventHub, "publish" | "boardChannel" | "taskChannel">,
  now: () => Date = () => new Date(),
): Promise<number> {
  const running = await db
    .select({ id: task.id, workspaceId: task.workspaceId, updatedAt: task.updatedAt })
    .from(task)
    .where(eq(task.state, "running"));

  let reclaimed = 0;
  for (const row of running) {
    if (registry.get(row.workspaceId, row.id)) continue;

    const [live] = await db
      .select({ id: session.id, startedAt: session.startedAt })
      .from(session)
      .where(
        and(
          eq(session.workspaceId, row.workspaceId),
          eq(session.taskId, row.id),
          ne(session.state, "closed"),
        ),
      )
      .orderBy(desc(session.startedAt))
      .limit(1);

    /*
     * The newest Session whatever state it is in, which is not always the live one.
     *
     * A Task can reach this sweep with its Session already closed — a previous sweep closed it,
     * or the run did — and be `running` again because someone moved it back on the board. The
     * evidence that decides between "interrupted" and "failed" lives in that Session's log, so
     * looking only at a non-closed Session would find nothing and file real work as a failure,
     * which is the exact case this rewrite exists to stop.
     */
    const [newest] = await db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.workspaceId, row.workspaceId), eq(session.taskId, row.id)))
      .orderBy(desc(session.startedAt))
      .limit(1);
    const evidenceIn = live?.id ?? newest?.id ?? null;

    // The second signal. `lastSpoke` falls back through what is available: the newest event this
    // run produced, else the Session's own start (a launch that hung before the agent's first
    // word has produced nothing, and its Session's age is the honest measure of how long), else
    // the Task's last write for a `running` Task carrying no Session at all — which should not
    // happen, and if it does the Task is orphaned by definition.
    const lastSpoke = live ? await latestActivity(db, live.id, live.startedAt) : row.updatedAt;
    if (now().getTime() - Date.parse(lastSpoke) < RECLAIM_STALE_MS) continue;

    /*
     * Orphaned mid-work, or orphaned having finished — and, in between, orphaned having done
     * real work it never got to declare.
     *
     * The sweep used to answer this from one signal, the `agent_done` marker, and file anything
     * without it as a failure. That was wrong in the most common case there is: an agent that
     * finishes its turn and waits for the operator has not ended its process, so it writes no
     * marker, and a `bun --hot` reload or a restart then buried real work in the Failed column.
     *
     * So it now reads the evidence in order of strength:
     *
     *   1. `agent_done`      — the agent said it finished. Record the declaration; a person opens
     *                          the gate (the run itself no longer moves a Task to review either).
     *   2. a captured `diff` — the agent produced a change at some turn boundary. The work exists
     *                          and is described; the Task goes back to `ready` to be resumed, and
     *                          nothing is filed as a failure.
     *   3. nothing at all    — no marker, no change, no evidence the run achieved anything. This
     *                          is the only case that is a failure, and it is the honest one.
     *
     * What none of the three does is capture a diff: the worktree deps belong to the run, so a
     * sweep can only read what the run already wrote down.
     */
    const finished = evidenceIn ? await completionMarker(db, evidenceIn) : null;
    const endedAt = now().toISOString();

    if (finished) {
      await recordTaskCompletion(db, row.workspaceId, row.id, {
        outcome: finished.outcome ?? "changes_ready",
        summary: finished.summary ?? null,
        at: endedAt,
      });
      if (live) {
        await setSessionState(db, row.workspaceId, live.id, "awaiting_review", {
          diffRef: finished.branch,
        });
        await appendSessionEvent(db, row.workspaceId, {
          sessionId: live.id,
          seq: await nextSessionEventSeq(db, row.workspaceId, live.id),
          payload: { kind: "state", from: "running", to: "running", reason: RECOVERED_REASON },
        });
      }
      // The Task does not move: it is finished and waiting for a person, which is exactly what
      // the board now draws. Announced so the card gains its control without a reload.
      announce(hub, row, "running", endedAt);
      reclaimed += 1;
      continue;
    }

    const produced = evidenceIn ? await capturedChange(db, evidenceIn) : false;
    if (produced) {
      // Work exists and is readable. Sending this to `failed` is what buried it; `ready` is the
      // state a person can act on, and the reason says what happened to the run rather than
      // implying something was wrong with the work.
      await setTaskState(db, row.workspaceId, row.id, "ready", { failureReason: null });
      if (live) {
        await setSessionState(db, row.workspaceId, live.id, "closed", { endedAt });
        await appendSessionEvent(db, row.workspaceId, {
          sessionId: live.id,
          seq: await nextSessionEventSeq(db, row.workspaceId, live.id),
          payload: { kind: "state", from: "running", to: "ready", reason: INTERRUPTED_REASON },
        });
      }
      announce(hub, row, "ready", endedAt);
      reclaimed += 1;
      continue;
    }

    await setTaskState(db, row.workspaceId, row.id, "failed", {
      failureReason: INTERRUPTED_REASON,
    });
    if (live) {
      await setSessionState(db, row.workspaceId, live.id, "closed", { endedAt });
      // The transcript's own record of why, in the same vocabulary a normal run failure uses
      // (see `recordTransition` in task-run.ts) — an Owner reading the log afterwards sees a
      // stated reason, not a state that changed with no explanation.
      await appendSessionEvent(db, row.workspaceId, {
        sessionId: live.id,
        seq: await nextSessionEventSeq(db, row.workspaceId, live.id),
        payload: { kind: "state", from: "running", to: "failed", reason: INTERRUPTED_REASON },
      });
    }
    announce(hub, row, "failed", endedAt);
    reclaimed += 1;
  }
  return reclaimed;
}

/** When this Session last produced anything, falling back to when it began. */
async function latestActivity(db: Db, sessionId: string, startedAt: string): Promise<string> {
  const [newest] = await db
    .select({ at: sessionEvent.at })
    .from(sessionEvent)
    .where(eq(sessionEvent.sessionId, sessionId))
    .orderBy(desc(sessionEvent.at))
    .limit(1);
  return newest?.at ?? startedAt;
}

/**
 * The reason a Task recovered by this sweep carries into review.
 *
 * Distinct from `interrupted`, and the distinction is the point: both say the run was lost, and
 * only one says the work survived it. A reviewer opening this Task is looking at real changes
 * that nothing else would have shown them.
 */
export const RECOVERED_REASON = "recovered_after_restart";

/**
 * The `agent_done` this Session ended on, if it ended on one.
 *
 * Read as "the newest marker in the log", not "the last event is a marker": an agent's final turn
 * and the compaction step both land after it, and neither of them means the agent did not finish.
 * There is no ambiguity to resolve — a marker is only ever written once the agent has stopped
 * having completed, so its presence is the fact, whatever came afterwards.
 */
async function completionMarker(
  db: Db,
  sessionId: string,
): Promise<{
  branch: string;
  outcome: TaskCompletionOutcome | null;
  summary: string | null;
} | null> {
  const [newest] = await db
    .select({ payload: sessionEvent.payload })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.kind, "agent_done")))
    .orderBy(desc(sessionEvent.seq))
    .limit(1);
  if (!newest) return null;
  const parsed = parseSessionEventPayload("agent_done", newest.payload);
  if (parsed.kind !== "agent_done") return null;
  return {
    branch: parsed.branch,
    outcome: parsed.outcome ?? null,
    summary: parsed.summary ?? null,
  };
}

/**
 * Whether this Session produced a change anyone can still read.
 *
 * The second-strongest evidence there is, and the one that decides between "interrupted" and
 * "failed". A `diff` record means the agent edited something and the orchestrator captured it —
 * at a turn boundary during the run, or at the gate. Work that is described in the log is work
 * that survives the run being lost, and filing it as a failure is what buried it.
 */
async function capturedChange(db: Db, sessionId: string): Promise<boolean> {
  const [any] = await db
    .select({ id: sessionEvent.id })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.kind, "diff")))
    .limit(1);
  return any !== undefined;
}

/**
 * Tell everyone watching. Both channels, as `announce` in task-run.ts does: whoever is looking at
 * this Task's own page is the person most likely to be waiting on this reclaim, and they were the
 * ones it never reached.
 */
function announce(
  hub: Pick<EventHub, "publish" | "boardChannel" | "taskChannel">,
  row: { id: string; workspaceId: string },
  state: "failed" | "review" | "ready" | "running",
  at: string,
): void {
  const message = { kind: "status" as const, taskId: row.id, state, at };
  hub.publish(hub.boardChannel(row.workspaceId), message);
  hub.publish(hub.taskChannel(row.workspaceId, row.id), message);
}
