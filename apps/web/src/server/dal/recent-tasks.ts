import "server-only";
import { ok, type RecentTaskListDto, type Result } from "@solow/contracts";
import { project, projectItem, task } from "@solow/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { taskToDto } from "./mappers.js";
import { getRecentTasks } from "./preference.js";
import { attachmentsForTasks, liveTask } from "./task.js";

/**
 * The signed-in user's recent Tasks, loaded: one read for the ids, one for the rows, one for their
 * attachments and one for their Projects — instead of the sidebar asking once per id.
 *
 * An Issue in two Projects is named by the first by title, the same answer every time.
 *
 * Most recent first, in the stored order. An id whose Task has since been deleted, or that is not
 * this Workspace's, is simply absent (Principle V): it ages out of the stored list by itself.
 */
export async function listRecentTasks(ctx: RequestContext): Promise<Result<RecentTaskListDto>> {
  const recent = await getRecentTasks(ctx);
  if (!recent.ok) return recent;
  const ids = recent.data.taskIds;
  if (ids.length === 0) return ok([]);

  const rows = await ctx.db
    .select()
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), inArray(task.id, ids), liveTask()));
  const attachments = await attachmentsForTasks(
    ctx,
    rows.map((r) => r.id),
  );
  const byId = new Map(rows.map((r) => [r.id, taskToDto(r, attachments.get(r.id) ?? [])]));

  const issueIds = [...new Set(rows.map((r) => r.issueId))];
  const holders = await ctx.db
    .select({ issueId: projectItem.issueId, id: project.id, title: project.title })
    .from(projectItem)
    .innerJoin(project, eq(project.id, projectItem.projectId))
    .where(
      and(
        eq(projectItem.workspaceId, ctx.workspaceId),
        eq(project.workspaceId, ctx.workspaceId),
        inArray(projectItem.issueId, issueIds),
      ),
    )
    .orderBy(asc(project.title));
  const projectOf = new Map<string, { id: string; title: string }>();
  for (const h of holders) {
    if (!projectOf.has(h.issueId)) projectOf.set(h.issueId, { id: h.id, title: h.title });
  }

  return ok(
    ids.flatMap((id) => {
      const found = byId.get(id);
      return found ? [{ task: found, project: projectOf.get(found.issueId) ?? null }] : [];
    }),
  );
}
