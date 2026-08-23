import { parseSessionEventPayload } from "@gatecontrol/contracts";
import { INTERRUPTED_REASON } from "@gatecontrol/core";
import { type Db, session, sessionEvent, task } from "@gatecontrol/db";
import { and, desc, eq, ne } from "drizzle-orm";
import type { AgentRegistry } from "./agent/registry.js";
import { appendSessionEvent, nextSessionEventSeq, setSessionState, setTaskState } from "./data.js";
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

    // The second signal. `lastSpoke` falls back through what is available: the newest event this
    // run produced, else the Session's own start (a launch that hung before the agent's first
    // word has produced nothing, and its Session's age is the honest measure of how long), else
    // the Task's last write for a `running` Task carrying no Session at all — which should not
    // happen, and if it does the Task is orphaned by definition.
    const lastSpoke = live ? await latestActivity(db, live.id, live.startedAt) : row.updatedAt;
    if (now().getTime() - Date.parse(lastSpoke) < RECLAIM_STALE_MS) continue;

    /*
     * Orphaned mid-work, or orphaned having finished?
     *
     * Until `agent_done` existed this sweep could not tell, and had to assume the worse of the
     * two: a Task whose agent had done the work and committed it was filed as a failure, because
     * the run was lost between the agent's last word and the step that would have moved it to
     * review. That is the single most common way a clean run ended up in the Failed column.
     *
     * The marker settles it, and it carries the branch — which `to-review`'s own comment calls
     * the only thing a reviewer strictly needs. So the sweep finishes the job the run did not:
     * the Task goes to review, on its branch, and a person decides. What it cannot do is capture
     * the diff, because the worktree deps belong to the run; the gate degrades to "no diff shown"
     * rather than to a wrong verdict, exactly as `to-review` already degrades when a capture
     * fails.
     */
    const finished = live ? await completionMarker(db, live.id) : null;
    const endedAt = now().toISOString();

    if (finished) {
      await setTaskState(db, row.workspaceId, row.id, "review");
      if (live) {
        await setSessionState(db, row.workspaceId, live.id, "awaiting_review", {
          diffRef: finished.branch,
        });
        await appendSessionEvent(db, row.workspaceId, {
          sessionId: live.id,
          seq: await nextSessionEventSeq(db, row.workspaceId, live.id),
          payload: { kind: "state", from: "running", to: "review", reason: RECOVERED_REASON },
        });
      }
      announce(hub, row, "review", endedAt);
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
async function completionMarker(db: Db, sessionId: string): Promise<{ branch: string } | null> {
  const [newest] = await db
    .select({ payload: sessionEvent.payload })
    .from(sessionEvent)
    .where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.kind, "agent_done")))
    .orderBy(desc(sessionEvent.seq))
    .limit(1);
  if (!newest) return null;
  const parsed = parseSessionEventPayload("agent_done", newest.payload);
  return parsed.kind === "agent_done" ? { branch: parsed.branch } : null;
}

/**
 * Tell everyone watching. Both channels, as `announce` in task-run.ts does: whoever is looking at
 * this Task's own page is the person most likely to be waiting on this reclaim, and they were the
 * ones it never reached.
 */
function announce(
  hub: Pick<EventHub, "publish" | "boardChannel" | "taskChannel">,
  row: { id: string; workspaceId: string },
  state: "failed" | "review",
  at: string,
): void {
  const message = { kind: "status" as const, taskId: row.id, state, at };
  hub.publish(hub.boardChannel(row.workspaceId), message);
  hub.publish(hub.taskChannel(row.workspaceId, row.id), message);
}
