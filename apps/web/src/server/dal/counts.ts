import "server-only";
import { ok, type Result, type WorkspaceCountsDto } from "@solow/contracts";
import { issue, projectItem, task } from "@solow/db";
import { and, count, countDistinct, eq, notInArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { liveTask } from "./task.js";

/**
 * The navigation's counts, as `count()` queries scoped to the caller's Workspace (Principle V).
 *
 * "Unassigned" means exactly what `listIssues({ unassigned: true })` means — no `project_item`
 * row in this Workspace names the Issue — so the number beside the link is the length of the
 * page it opens.
 *
 * Review counts reach a Project through the Task's Issue, as `listTasks({ projectId })` does, so a
 * badge never disagrees with the board it sits beside. `countDistinct` because an Issue in two
 * Projects is two `project_item` rows: each Project counts its Task once, never twice.
 */
export async function workspaceCounts(ctx: RequestContext): Promise<Result<WorkspaceCountsDto>> {
  const [unassigned] = await ctx.db
    .select({ n: count() })
    .from(issue)
    .where(
      and(
        eq(issue.workspaceId, ctx.workspaceId),
        notInArray(
          issue.id,
          ctx.db
            .select({ id: projectItem.issueId })
            .from(projectItem)
            .where(eq(projectItem.workspaceId, ctx.workspaceId)),
        ),
      ),
    );
  const review = await ctx.db
    .select({ projectId: projectItem.projectId, tasks: countDistinct(task.id) })
    .from(task)
    .innerJoin(
      projectItem,
      and(eq(projectItem.issueId, task.issueId), eq(projectItem.workspaceId, ctx.workspaceId)),
    )
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.state, "review"), liveTask()))
    .groupBy(projectItem.projectId);

  return ok({ unassignedIssues: unassigned?.n ?? 0, reviewByProject: review });
}
