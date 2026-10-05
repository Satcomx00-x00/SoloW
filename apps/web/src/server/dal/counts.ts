import "server-only";
import { ok, type Result, type WorkspaceCountsDto } from "@solow/contracts";
import { issue, projectItem } from "@solow/db";
import { and, count, eq, notInArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * The navigation's counts, as `count()` queries scoped to the caller's Workspace (Principle V).
 *
 * "Unassigned" means exactly what `listIssues({ unassigned: true })` means — no `project_item`
 * row in this Workspace names the Issue — so the number beside the link is the length of the
 * page it opens.
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
  return ok({ unassignedIssues: unassigned?.n ?? 0 });
}
