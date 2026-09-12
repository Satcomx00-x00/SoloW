import { and, eq, inArray, or } from "drizzle-orm";
import {
  review,
  session,
  sessionEvent,
  sessionSummary,
  sessionUsage,
  task,
  taskDependency,
  taskRepository,
  worktree,
} from "./schema.js";

/**
 * Deleting Tasks and everything hanging off them, in the one order that never trips a foreign
 * key.
 *
 * It lives in the db package rather than beside either caller because three of them need
 * exactly the same walk — the web app's `deleteIssue`, and the orchestrator's retention sweep,
 * which purges a Task once its time in History is up (`deleteTask` itself only marks the row
 * now) — and two copies of a nine-statement cascade drift the moment a table is added; the
 * second one silently leaves orphans. Every caller passes a transaction it already opened, so
 * the check that decided the delete and the delete itself stay atomic.
 *
 * Not handled here, on purpose: the `worktree` *directories*. Removing those is the
 * orchestrator's job, on the far side of the Executor boundary; the sweep does it before it
 * calls this, and the web app never touches the filesystem at all.
 */
export function cascadeDeleteTasks(
  // The transaction object drizzle hands the callback — same surface as `db`, and drizzle exports
  // no type for it. No `biome-ignore` here: `noExplicitAny` does not fire on this project's
  // server code, and a suppression that suppresses nothing is a comment asserting a rule that
  // is not there — which is what `suppressions/unused` exists to catch.
  tx: any,
  workspaceId: string,
  taskIds: string[],
): void {
  if (taskIds.length === 0) return;

  const sessionIds = (
    tx
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.workspaceId, workspaceId), inArray(session.taskId, taskIds)))
      .all() as Array<{ id: string }>
  ).map((row) => row.id);

  // Every statement repeats the workspace scope even though `taskIds` is already scoped — the
  // tenant key belongs on every write in this layer (Principle V).
  if (sessionIds.length > 0) {
    tx.delete(sessionEvent)
      .where(
        and(eq(sessionEvent.workspaceId, workspaceId), inArray(sessionEvent.sessionId, sessionIds)),
      )
      .run();
    tx.delete(sessionSummary)
      .where(
        and(
          eq(sessionSummary.workspaceId, workspaceId),
          inArray(sessionSummary.sessionId, sessionIds),
        ),
      )
      .run();
    tx.delete(review)
      .where(and(eq(review.workspaceId, workspaceId), inArray(review.sessionId, sessionIds)))
      .run();
  }
  tx.delete(sessionUsage)
    .where(and(eq(sessionUsage.workspaceId, workspaceId), inArray(sessionUsage.taskId, taskIds)))
    .run();
  tx.delete(session)
    .where(and(eq(session.workspaceId, workspaceId), inArray(session.taskId, taskIds)))
    .run();
  tx.delete(worktree)
    .where(and(eq(worktree.workspaceId, workspaceId), inArray(worktree.taskId, taskIds)))
    .run();
  // Both columns: an edge pointing AT one of these Tasks blocks a Task that survives, and
  // leaving it would keep that survivor blocked by a row that no longer exists.
  tx.delete(taskDependency)
    .where(
      and(
        eq(taskDependency.workspaceId, workspaceId),
        or(
          inArray(taskDependency.taskId, taskIds),
          inArray(taskDependency.blockedByTaskId, taskIds),
        ),
      ),
    )
    .run();
  tx.delete(taskRepository)
    .where(
      and(eq(taskRepository.workspaceId, workspaceId), inArray(taskRepository.taskId, taskIds)),
    )
    .run();
  tx.delete(task)
    .where(and(eq(task.workspaceId, workspaceId), inArray(task.id, taskIds)))
    .run();
}
