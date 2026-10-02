import { count, eq } from "drizzle-orm";
import {
  changeRequest,
  executorProfile,
  harnessConfig,
  harnessProfile,
  integration,
  issue,
  mcpServer,
  mcpToken,
  project,
  projectField,
  projectItem,
  projectRepository,
  projectValue,
  projectView,
  providerIdentity,
  repository,
  repositoryBranch,
  repositoryLabel,
  secret,
  skill,
  task,
  uiPreference,
  workflow,
  workflowStep,
  worktree,
} from "./schema.js";
import { cascadeDeleteTasks } from "./task-cascade.js";

/**
 * Emptying a Workspace, in the one order that never trips a foreign key.
 *
 * It lives in the db package beside `cascadeDeleteTasks` and builds on it, because the two are
 * the same kind of knowledge — which table has to go before which — and splitting that knowledge
 * across two packages is how the second copy silently starts leaving orphans. This one is the
 * whole-Workspace walk; that one is the Task subtree, and this calls it rather than restating
 * its nine statements.
 *
 * **What it never deletes**: the `workspace` row itself, the `auth_*` tables, and
 * `harness_catalog`. The first two are the tenant and the account the request arrived through —
 * a reset that removed them would have nowhere to answer from (Principle V) and would sign the
 * Owner out of a machine they may be the only user of. The third is not user data at all: it is
 * the set of harnesses this build knows how to run, seeded by `ensureDefaultHarnessCatalog` on
 * every boot, so deleting it would be undone by the next start anyway.
 *
 * Like `cascadeDeleteTasks`, the worktree *directories* are not handled here. The rows naming
 * them are read before they are deleted and handed back in `worktrees`, for the caller to give
 * to the orchestrator on the far side of the Executor boundary (Decision 0025) — the web app
 * never touches the filesystem.
 */

/** How much goes. See `workspaceResetScopeSchema` in `@solow/contracts` for what each means. */
export type WorkspaceResetScope = "work-data" | "everything";

export interface WorkspaceResetResult {
  /** One entry per table that lost rows, in the order they were deleted. Empty tables are omitted. */
  removed: Array<{ table: string; rows: number }>;
  rows: number;
  /**
   * The Tasks whose files the orchestrator is asked to remove, each with the worktree
   * directories its rows named — read before those rows were deleted, because afterwards there
   * is nothing left to ask. Grouped by Task rather than flattened because that is the shape
   * `purgeTaskFiles` takes: the orchestrator removes a Task's transcript and checkpoint stores
   * by id, and only the checkouts by path.
   */
  purge: Array<{ taskId: string; worktrees: string[] }>;
}

/**
 * The tables a `work-data` reset empties, in delete order.
 *
 * Work, not setup: what the Workspace has *done*, never what it *is*. Repositories, Profiles,
 * Secrets, Integrations, Workflows, libraries and preferences all survive, so the Workspace can
 * run something again the moment the reset finishes — which is the whole point of having a scope
 * short of a factory reset.
 *
 * `change_request` is in here rather than with the setup because a merge request is a fact about
 * work that was done; it is mirror data and a later sync will bring back whatever still exists
 * on the provider.
 */
const WORK_DATA_TABLES = [
  { table: "project_value", t: projectValue },
  { table: "project_item", t: projectItem },
  { table: "project_field", t: projectField },
  { table: "project_view", t: projectView },
  { table: "project_repository", t: projectRepository },
  { table: "project", t: project },
  { table: "change_request", t: changeRequest },
  { table: "issue", t: issue },
] as const;

/**
 * What a factory reset additionally removes, in delete order.
 *
 * Ordered by what points at what: Workflow Steps name a Harness Profile, so they go first;
 * Repositories are named by their branches and labels; and `integration` is last of the
 * referenced rows because Issues, Repositories, Change Requests and Projects all point at it,
 * and every one of those has already gone by the time this list runs.
 */
const SETUP_TABLES = [
  { table: "workflow_step", t: workflowStep },
  { table: "workflow", t: workflow },
  { table: "mcp_server", t: mcpServer },
  { table: "skill", t: skill },
  { table: "mcp_token", t: mcpToken },
  { table: "provider_identity", t: providerIdentity },
  { table: "harness_profile", t: harnessProfile },
  // After the Profiles that select it.
  { table: "harness_config", t: harnessConfig },
  { table: "executor_profile", t: executorProfile },
  { table: "repository_branch", t: repositoryBranch },
  { table: "repository_label", t: repositoryLabel },
  { table: "repository", t: repository },
  { table: "integration", t: integration },
  { table: "secret", t: secret },
  { table: "ui_preference", t: uiPreference },
] as const;

export function resetWorkspace(
  // The transaction object drizzle hands the callback — same surface as `db`, and drizzle exports
  // no type for it. Same reasoning as `cascadeDeleteTasks`, which this calls.
  tx: any,
  workspaceId: string,
  scope: WorkspaceResetScope,
): WorkspaceResetResult {
  const removed: Array<{ table: string; rows: number }> = [];

  /**
   * Counted before the delete rather than read off the statement's `changes`, because the count
   * is the receipt this action exists to produce (`workspaceResetDto`) and a driver-specific
   * result shape is the wrong thing to make that promise rest on.
   */
  const rowsIn = (t: any, column: any): number => {
    const [row] = tx.select({ n: count() }).from(t).where(eq(column, workspaceId)).all() as Array<{
      n: number;
    }>;
    return row?.n ?? 0;
  };

  const sweep = (entries: readonly { table: string; t: any }[]): void => {
    for (const { table, t } of entries) {
      const rows = rowsIn(t, t.workspaceId);
      if (rows === 0) continue;
      tx.delete(t).where(eq(t.workspaceId, workspaceId)).run();
      removed.push({ table, rows });
    }
  };

  const taskIds = (
    tx.select({ id: task.id }).from(task).where(eq(task.workspaceId, workspaceId)).all() as Array<{
      id: string;
    }>
  ).map((row) => row.id);

  // Read the directories out before the rows naming them are deleted — after the cascade there
  // is nothing left to ask, and the orchestrator needs the paths to remove the checkouts.
  const byTask = new Map<string, string[]>(taskIds.map((id) => [id, []]));
  for (const row of tx
    .select({ taskId: worktree.taskId, path: worktree.path })
    .from(worktree)
    .where(eq(worktree.workspaceId, workspaceId))
    .all() as Array<{ taskId: string; path: string }>) {
    byTask.get(row.taskId)?.push(row.path);
  }
  const purge = [...byTask].map(([taskId, worktrees]) => ({ taskId, worktrees }));

  if (taskIds.length > 0) {
    // The nine-statement Task subtree, unchanged — this is the caller `cascadeDeleteTasks`'s doc
    // comment means by "the orchestrator's retention sweep" gaining a third sibling.
    cascadeDeleteTasks(tx, workspaceId, taskIds);
    removed.push({ table: "task", rows: taskIds.length });
  }

  sweep(WORK_DATA_TABLES);
  if (scope === "everything") sweep(SETUP_TABLES);

  return { removed, rows: removed.reduce((sum, entry) => sum + entry.rows, 0), purge };
}
