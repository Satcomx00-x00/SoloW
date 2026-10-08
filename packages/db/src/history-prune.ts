import {
  HISTORY_PRUNED_EVENT_KINDS,
  type HistoryRetentionPreviewDto,
  type SessionState,
} from "@solow/contracts";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Db } from "./index.js";
import { session, sessionEvent, task, workspace } from "./schema.js";

/**
 * The transcript half of history retention (Decision 0032, FINDINGS F4).
 *
 * Here rather than in the orchestrator because two processes ask the same question: the
 * orchestrator's hourly sweep, which removes, and the web app's Settings page, which shows what a
 * window would remove before the Owner picks it. Two copies of "which Sessions are past the
 * window" would be two answers the day one of them gains a condition.
 *
 * What goes and what stays is `HISTORY_PRUNED_EVENT_KINDS` / `HISTORY_KEPT_EVENT_KINDS` in
 * `@solow/contracts`. No other table is touched: Sessions, summaries, reviews, token usage and
 * the Task itself stay for as long as the Task does, because History and the outcome metrics
 * are read from them.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Rows deleted per statement. Small enough that one statement holds SQLite's write lock for a
 * few milliseconds — the web app and the run loop write to this file too, and they wait out
 * whatever transaction holds it.
 */
export const HISTORY_PRUNE_BATCH = 500;

/**
 * Events removed per sweep, across every Workspace. A first sweep on an install with a year of
 * history has hundreds of thousands to remove; doing it in one go would pin the orchestrator's
 * event loop (bun:sqlite is synchronous) for as long as it took. The rest waits for the next
 * hourly pass, which is what the Session-level `events_pruned_at` mark is shaped for.
 */
export const HISTORY_PRUNE_MAX_EVENTS = 20_000;

/** The instant before which a finished Task's transcript is past a window of `days`. */
export function historyPruneCutoff(days: number, now: Date): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

const prunedKinds = sql.join(
  HISTORY_PRUNED_EVENT_KINDS.map((kind) => sql`${kind}`),
  sql`, `,
);

/** A Session in these states may still be wanted whole, and so may every other one of its Task. */
const HELD_SESSION_STATES = ["active", "resumable"] as const satisfies readonly SessionState[];

const heldStates = sql.join(
  HELD_SESSION_STATES.map((state) => sql`${state}`),
  sql`, `,
);

/** A captured diff whose patch text has not been emptied yet. */
const patchHeld = sql`coalesce(json_extract(${sessionEvent.payload}, '$.patch'), '') <> ''`;

/**
 * A Session whose transcript is due: its Task finished — Done, or deleted — longer ago than the
 * window, and nothing could still want the conversation.
 *
 * "Finished at" is `updated_at` for a Done Task and `deleted_at` for a deleted one, the same marks
 * the worktree half of retention reads (`retention.ts` in the orchestrator). A Done Task that is
 * touched again — reopened, retitled — moves its own clock forward, which errs towards keeping.
 *
 * Two things hold a Session back however old it is:
 *  - **a Session on the same Task that is live or can be resumed** (`HELD_SESSION_STATES`): a
 *    reopened Task running again is not finished, whatever its row said a moment ago, and a
 *    resumable one hands its conversation back when it is picked up;
 *  - **any sub-task forked from it that still exists**: a fork point is verified by hashing the
 *    events up to it (`loadForkOrigin`) on every full brief, not only the first, so a sub-task
 *    reopened from Done or restored from History would be refused as stale. Only the purge,
 *    which deletes the sub-task's row, releases the parent.
 */
function dueSessions(workspaceId: string, cutoff: string): SQL {
  return and(
    eq(session.workspaceId, workspaceId),
    isNull(session.eventsPrunedAt),
    notInArray(session.state, [...HELD_SESSION_STATES]),
    or(
      and(isNotNull(task.deletedAt), lt(task.deletedAt, cutoff)),
      and(isNull(task.deletedAt), eq(task.state, "done"), lt(task.updatedAt, cutoff)),
    ),
    sql`not exists (select 1 from session held where held.task_id = ${task.id} and held.workspace_id = ${task.workspaceId} and held.state in (${heldStates}))`,
    sql`not exists (select 1 from task child where child.fork_session_id = ${session.id} and child.workspace_id = ${session.workspaceId})`,
  ) as SQL;
}

/**
 * The same question for one Session, asked inside each statement that removes from it.
 *
 * The due list is read once per Workspace and the sweep yields between batches, while the web app
 * and the run loop keep writing to the file: a Task can be reopened, or a sub-task forked from it,
 * after its Session was listed. Asking inside the DELETE or UPDATE itself, rather than in a query
 * before it, leaves no gap between the answer and the write.
 */
function stillDue(db: Db, workspaceId: string, sessionId: string, cutoff: string): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(session)
      .innerJoin(task, and(eq(task.id, session.taskId), eq(task.workspaceId, session.workspaceId)))
      .where(and(eq(session.id, sessionId), dueSessions(workspaceId, cutoff))),
  );
}

/** How many of a Session's events are of these kinds, answered from `session_event_kind` alone. */
const eventsOf = (kinds: SQL) =>
  sql<number>`(select count(*) from ${sessionEvent} where ${sessionEvent.sessionId} = ${session.id} and ${sessionEvent.kind} in (${kinds}))`;

/**
 * What a window of `days` would remove from this Workspace if the sweep ran now. `null` — keep
 * forever — removes nothing, and is answered without a query.
 *
 * Settings asks this from the web process, synchronously, for each window the Owner considers,
 * so it only counts: the due Sessions, then each one's events by kind through the
 * `(session_id, kind)` index. No payload is read. That is also why there is no byte figure: the
 * only honest one is the payloads' length, which means reading every one of them, and the file
 * would not shrink by that amount anyway (no vacuum, Decision 0032 §8).
 *
 * Diffs are counted, not inspected: the sweep empties the patch of each one in a due Session
 * that still holds one, so a diff captured with an empty patch is counted here and skipped there.
 */
export function previewHistoryPrune(
  db: Db,
  workspaceId: string,
  days: number | null,
  now: Date = new Date(),
): HistoryRetentionPreviewDto {
  const none = { tasks: 0, sessions: 0, events: 0, diffs: 0 };
  if (days === null) return none;
  const cutoff = historyPruneCutoff(days, now);

  const row = db
    .select({
      tasks: sql<number>`count(distinct ${session.taskId})`,
      sessions: sql<number>`count(*)`,
      events: sql<number>`coalesce(sum(${eventsOf(prunedKinds)}), 0)`,
      diffs: sql<number>`coalesce(sum(${eventsOf(sql`'diff'`)}), 0)`,
    })
    .from(session)
    .innerJoin(task, and(eq(task.id, session.taskId), eq(task.workspaceId, session.workspaceId)))
    .where(dueSessions(workspaceId, cutoff))
    .get();

  return row
    ? {
        tasks: Number(row.tasks),
        sessions: Number(row.sessions),
        events: Number(row.events),
        diffs: Number(row.diffs),
      }
    : none;
}

export interface HistoryPruneOptions {
  now?: Date;
  batchSize?: number;
  /** Stop once this many events are gone; the next sweep carries on. */
  maxEvents?: number;
  /** Between batches — gives the process's other work a turn. A test passes a no-op. */
  pause?: () => Promise<void>;
}

export interface HistoryPruneReport {
  /** Sessions whose transcript is now entirely gone (and marked so). */
  sessions: number;
  events: number;
  /** Diffs whose patch text was emptied. */
  diffs: number;
  /** True when the event bound stopped the sweep with Sessions still due. */
  more: boolean;
}

/**
 * Remove the transcripts that are past each Workspace's window, in bounded batches.
 *
 * Idempotent and resumable: a Session is marked only once its last transcript event is gone,
 * so a sweep stopped by `maxEvents`, a crash or a restart leaves it unmarked and the next one
 * finishes it. A Workspace whose window is null is skipped entirely.
 */
export async function pruneHistory(
  db: Db,
  options: HistoryPruneOptions = {},
): Promise<HistoryPruneReport> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? HISTORY_PRUNE_BATCH;
  const maxEvents = options.maxEvents ?? HISTORY_PRUNE_MAX_EVENTS;
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const report: HistoryPruneReport = { sessions: 0, events: 0, diffs: 0, more: false };

  const windows = db
    .select({ id: workspace.id, days: workspace.historyRetentionDays })
    .from(workspace)
    .where(isNotNull(workspace.historyRetentionDays))
    .all();

  for (const { id: workspaceId, days } of windows) {
    if (days === null) continue;
    const cutoff = historyPruneCutoff(days, now);
    const due = db
      .select({ id: session.id })
      .from(session)
      .innerJoin(task, and(eq(task.id, session.taskId), eq(task.workspaceId, session.workspaceId)))
      .where(dueSessions(workspaceId, cutoff))
      .all();

    for (const { id: sessionId } of due) {
      if (report.events >= maxEvents) {
        report.more = true;
        return report;
      }

      // Deleted a batch at a time, each its own statement, so no single write holds the lock
      // for long and a stop between batches loses nothing.
      for (;;) {
        const limit = Math.min(batchSize, maxEvents - report.events);
        const changes = db
          .delete(sessionEvent)
          .where(
            inArray(
              sessionEvent.id,
              db
                .select({ id: sessionEvent.id })
                .from(sessionEvent)
                .where(
                  and(
                    eq(sessionEvent.workspaceId, workspaceId),
                    eq(sessionEvent.sessionId, sessionId),
                    inArray(sessionEvent.kind, [...HISTORY_PRUNED_EVENT_KINDS]),
                    stillDue(db, workspaceId, sessionId, cutoff),
                  ),
                )
                .limit(limit),
            ),
          )
          .returning({ id: sessionEvent.id })
          .all().length;
        report.events += changes;
        if (changes < limit) break;
        await pause();
        if (report.events >= maxEvents) {
          report.more = true;
          return report;
        }
      }

      // The file list and line counts stay — the round view reads them — and the patch, by far
      // the biggest field, goes. `truncated` is the flag the diff viewer already understands
      // for "the patch here is not the whole change".
      const stripped = db
        .update(sessionEvent)
        .set({
          payload: sql`json_set(${sessionEvent.payload}, '$.patch', '', '$.truncated', json('true'))`,
        })
        .where(
          and(
            eq(sessionEvent.workspaceId, workspaceId),
            eq(sessionEvent.sessionId, sessionId),
            eq(sessionEvent.kind, "diff"),
            patchHeld,
            stillDue(db, workspaceId, sessionId, cutoff),
          ),
        )
        .returning({ id: sessionEvent.id })
        .all();
      report.diffs += stripped.length;

      // A Session that stopped being due part-way keeps what is left, unstamped; the next sweep
      // that finds it due again finishes it.
      const stamped = db
        .update(session)
        .set({ eventsPrunedAt: now.toISOString() })
        .where(
          and(
            eq(session.workspaceId, workspaceId),
            eq(session.id, sessionId),
            stillDue(db, workspaceId, sessionId, cutoff),
          ),
        )
        .returning({ id: session.id })
        .all();
      report.sessions += stamped.length;
    }
  }

  return report;
}
