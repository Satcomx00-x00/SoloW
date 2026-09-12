import { TASK_RETENTION_MS } from "@solow/core";
import { cascadeDeleteTasks, type Db, session, task, worktree } from "@solow/db";
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import type { Executor } from "./executor/types.js";
import {
  cleanupWorktree,
  harnessTranscriptsPath,
  repositoryOfWorktree,
} from "./worktree/manager.js";

/**
 * How long a closed or deleted Task stays in History before this sweep takes back what it left
 * behind (spec F02 FR-10, F11; Decision 0025).
 *
 * Two things are kept for the retention window, for two reasons. The **rows** — Task, Sessions,
 * events, reviews — are what make a deleted Task restorable and a Done one readable; the
 * **worktree directories** are what make either *resumable*: Claude Code keys a conversation's
 * transcript to the directory it ran in, so a relaunch that wants to continue the conversation
 * has to run in the same directory. The lifecycle therefore no longer removes a worktree at
 * approve or reject; this sweep does, once the window has passed.
 *
 * Two arms, both idempotent and both per-Task so one Task's failure never stops the rest:
 *
 *  1. **Purge.** A Task deleted longer ago than the window: its worktree directories are removed
 *     (git first, so the branch is unregistered, then the row marked), then the whole record is
 *     cascaded — the same walk the web app's `deleteIssue` uses.
 *  2. **Expire.** A Done Task whose last Session ended longer ago than the window and which still
 *     holds a worktree: the directory goes and the Session becomes `closed` — no longer
 *     `resumable`. The rows stay: History stays readable for as long as the Task exists; only
 *     the ability to continue the conversation expires.
 *
 * Hourly rather than every sweep of reconcile's minute: a day's slack on a week's window costs
 * nothing, and a `git worktree remove` per Task per minute is churn the box would notice.
 */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionDeps {
  db: Db;
  /** The host, where every worktree directory lives whichever executor made it. */
  host: Executor;
  /**
   * `SOLOW_WORKTREE_ROOT`, absolute — where a containerised Task's transcript store sits
   * (`harnessTranscriptsPath`). Omitted in a test that has no such store to remove.
   */
  worktreeRoot?: string;
  /** Test seam: the window, defaulting to the product's one number for it. */
  retentionMs?: number;
}

export interface RetentionReport {
  purged: number;
  expired: number;
}

/** A Task with any Session still live is never touched, however old its marks are. */
async function hasActiveSession(db: Db, workspaceId: string, taskId: string): Promise<boolean> {
  const rows = await db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.workspaceId, workspaceId),
        eq(session.taskId, taskId),
        eq(session.state, "active"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Remove a Task's remaining worktree directories from disk and mark their rows.
 *
 * Best effort per directory: one already gone by hand is marked and moved past, and one git
 * refuses to remove is logged and left for the next pass rather than blocking the rest.
 */
async function removeWorktrees(
  deps: RetentionDeps,
  workspaceId: string,
  taskId: string,
  log: (message: string, cause?: unknown) => void,
): Promise<boolean> {
  const rows = await deps.db
    .select({ id: worktree.id, path: worktree.path })
    .from(worktree)
    .where(
      and(
        eq(worktree.workspaceId, workspaceId),
        eq(worktree.taskId, taskId),
        eq(worktree.status, "active"),
      ),
    );
  let allGone = true;
  // The transcripts a containerised run left on the host go with the worktrees: without the
  // directory they were keyed to they resume nothing, and they are the one thing here that
  // holds the conversation's text.
  if (deps.worktreeRoot) {
    try {
      await deps.host.exec(["rm", "-rf", "--", harnessTranscriptsPath(deps.worktreeRoot, taskId)]);
    } catch (cause) {
      log(`retention: could not remove transcripts of task ${taskId}`, cause);
    }
  }
  for (const row of rows) {
    try {
      const repoPath = await repositoryOfWorktree(deps.host, row.path);
      // A path git no longer recognises is one somebody removed already: nothing to do but agree.
      if (repoPath !== null) await cleanupWorktree(deps.host, repoPath, row.path);
      await deps.db
        .update(worktree)
        .set({ status: "removed", updatedAt: new Date().toISOString() })
        .where(eq(worktree.id, row.id));
    } catch (cause) {
      allGone = false;
      log(`retention: could not remove worktree ${row.path}`, cause);
    }
  }
  return allGone;
}

export async function retentionSweep(
  deps: RetentionDeps,
  now: () => Date = () => new Date(),
  log: (message: string, cause?: unknown) => void = (message, cause) =>
    console.error(`[solow/orchestrator] ${message}`, cause ?? ""),
): Promise<RetentionReport> {
  const cutoff = new Date(now().getTime() - (deps.retentionMs ?? TASK_RETENTION_MS)).toISOString();
  const report: RetentionReport = { purged: 0, expired: 0 };

  // 1. Purge: deleted longer ago than the window.
  const deleted = await deps.db
    .select({ id: task.id, workspaceId: task.workspaceId })
    .from(task)
    .where(and(isNotNull(task.deletedAt), lt(task.deletedAt, cutoff)));
  for (const row of deleted) {
    try {
      if (await hasActiveSession(deps.db, row.workspaceId, row.id)) continue;
      // Directories first: once the rows are gone nothing remembers where they were.
      if (!(await removeWorktrees(deps, row.workspaceId, row.id, log))) continue;
      deps.db.transaction((tx) => {
        cascadeDeleteTasks(tx, row.workspaceId, [row.id]);
      });
      report.purged += 1;
    } catch (cause) {
      log(`retention: purge of task ${row.id} failed`, cause);
    }
  }

  // 2. Expire: Done longer ago than the window, worktree still on disk.
  const done = await deps.db
    .select({ id: task.id, workspaceId: task.workspaceId, updatedAt: task.updatedAt })
    .from(task)
    .where(and(eq(task.state, "done"), isNull(task.deletedAt), lt(task.updatedAt, cutoff)));
  for (const row of done) {
    try {
      const held = await deps.db
        .select({ id: worktree.id })
        .from(worktree)
        .where(
          and(
            eq(worktree.workspaceId, row.workspaceId),
            eq(worktree.taskId, row.id),
            eq(worktree.status, "active"),
          ),
        )
        .limit(1);
      if (held.length === 0) continue;
      if (await hasActiveSession(deps.db, row.workspaceId, row.id)) continue;
      if (!(await removeWorktrees(deps, row.workspaceId, row.id, log))) continue;
      // The conversation can no longer be continued: say so on the Sessions, which is where the
      // History page reads resumability from.
      await deps.db
        .update(session)
        .set({ state: "closed" })
        .where(
          and(
            eq(session.workspaceId, row.workspaceId),
            eq(session.taskId, row.id),
            eq(session.state, "resumable"),
          ),
        );
      report.expired += 1;
    } catch (cause) {
      log(`retention: expiry of task ${row.id} failed`, cause);
    }
  }

  return report;
}
