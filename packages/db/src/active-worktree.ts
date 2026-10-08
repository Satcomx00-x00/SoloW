import { and, eq, type SQL, type SQLWrapper } from "drizzle-orm";
import { worktree } from "./schema.js";

/**
 * A `worktree` row the Task still holds on disk: what makes a finished Task resumable.
 *
 * One definition because two arms of retention ask it. The expiry arm takes a Done Task's
 * worktrees once its week in History is up, and closes its Sessions then. The transcript arm
 * holds a `resumable` Session back only while this is true: a resume continues the harness's
 * conversation inside the worktree, and once that is gone nothing can resume, whatever the
 * Session row still says.
 *
 * Takes values or columns, so it reads the same as a WHERE for one known Task and as a
 * correlated subquery over `task`.
 */
export function activeWorktreeOf(
  workspaceId: string | SQLWrapper,
  taskId: string | SQLWrapper,
): SQL {
  return and(
    eq(worktree.workspaceId, workspaceId),
    eq(worktree.taskId, taskId),
    eq(worktree.status, "active"),
  ) as SQL;
}
