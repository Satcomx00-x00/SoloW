import "server-only";
import {
  CommonErrorCode,
  type CreateProjectViewInput,
  createProjectViewInput,
  DEFAULT_PROJECT_VIEW_CONFIG,
  EMPTY_PROJECT_FILTER,
  err,
  ok,
  type ProjectViewConfig,
  type ProjectViewDto,
  projectFilterSchema,
  type ReorderProjectViewsInput,
  type Result,
  type UpdateProjectViewInput,
} from "@gatecontrol/contracts";
import { project, projectView } from "@gatecontrol/db";
import { and, asc, eq, max } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * Saved views over a Project (spec F23 FR-9, issue #129).
 *
 * A view is a configuration and nothing else — this file never reads, writes or copies an item.
 * That is the property the whole feature rests on: `Prioritized backlog` and `In review` are two
 * questions asked of one set of rows, so a value edited under one tab is edited under both,
 * because there was only ever one row.
 *
 * Workspace-scoped on every read and write (Principle V), and the Project is checked before a
 * view is attached to it — otherwise a view id from another tenant's project would be a way to
 * learn that project exists.
 */

/**
 * A stored row as the API's view of it.
 *
 * The filter is re-parsed rather than trusted: a predicate written by a newer build, or a row
 * edited by hand, must not take the tab strip down with it. It degrades to "no clauses", which
 * shows *more* rows than intended — visible and correctable, where degrading to "match nothing"
 * would render an empty table that looks exactly like an empty project.
 */
function toViewDto(row: typeof projectView.$inferSelect): ProjectViewDto {
  const filter = projectFilterSchema.safeParse(row.filter);
  const config: ProjectViewConfig = {
    layout: row.layout,
    filter: filter.success ? filter.data : EMPTY_PROJECT_FILTER,
    groupByFieldId: row.groupByFieldId,
    // Both halves or neither: a field with no direction is not a sort, it is half a write.
    sort:
      row.sortField && row.sortDirection
        ? { field: row.sortField, direction: row.sortDirection }
        : null,
    visibleFieldIds: row.visibleFieldIds,
  };
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    position: row.position,
    config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The columns a config writes to. Kept in one place so create and update cannot disagree. */
function toColumns(config: ProjectViewConfig) {
  return {
    layout: config.layout,
    filter: config.filter,
    groupByFieldId: config.groupByFieldId,
    sortField: config.sort?.field ?? null,
    sortDirection: config.sort?.direction ?? null,
    visibleFieldIds: config.visibleFieldIds,
  };
}

async function ownsProject(ctx: RequestContext, projectId: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, projectId)))
    .limit(1);
  return row !== undefined;
}

/** Every tab of one Project, in the order the team put them in. */
export async function listProjectViews(
  ctx: RequestContext,
  projectId: string,
): Promise<ProjectViewDto[]> {
  const rows = await ctx.db
    .select()
    .from(projectView)
    .where(and(eq(projectView.workspaceId, ctx.workspaceId), eq(projectView.projectId, projectId)))
    .orderBy(asc(projectView.position), asc(projectView.createdAt));
  return rows.map(toViewDto);
}

/**
 * Add a tab, at the end of the strip.
 *
 * At the end rather than at the front because the strip is a place people learn: a new view
 * appearing before `Prioritized backlog` would move every tab the team already reaches for.
 */
export async function createProjectView(
  ctx: RequestContext,
  input: CreateProjectViewInput,
): Promise<Result<ProjectViewDto, typeof CommonErrorCode.NotFound>> {
  const parsed = createProjectViewInput.parse(input);
  if (!(await ownsProject(ctx, parsed.projectId))) return err(CommonErrorCode.NotFound);

  const [tail] = await ctx.db
    .select({ last: max(projectView.position) })
    .from(projectView)
    .where(
      and(
        eq(projectView.workspaceId, ctx.workspaceId),
        eq(projectView.projectId, parsed.projectId),
      ),
    );

  const config = parsed.config ?? DEFAULT_PROJECT_VIEW_CONFIG;
  const [row] = await ctx.db
    .insert(projectView)
    .values({
      workspaceId: ctx.workspaceId,
      projectId: parsed.projectId,
      name: parsed.name,
      position: (tail?.last ?? -1) + 1,
      ...toColumns(config),
    })
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  return ok(toViewDto(row));
}

/**
 * Rename a view, reconfigure it, or both.
 *
 * `undefined` leaves a half alone. A rename that also rewrote the configuration from a caller's
 * stale copy is how somebody's filter quietly reverts, and this is a *shared* tab — the person
 * whose filter it was is not necessarily the person renaming it.
 */
export async function updateProjectView(
  ctx: RequestContext,
  input: UpdateProjectViewInput,
): Promise<Result<ProjectViewDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(projectView)
    .set({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.config === undefined ? {} : toColumns(input.config)),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(projectView.workspaceId, ctx.workspaceId), eq(projectView.id, input.viewId)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  return ok(toViewDto(row));
}

/**
 * Put the tab strip in the order given.
 *
 * The whole strip at once, and refused unless the ids are exactly this Project's views: a
 * partial reorder is applied against an order the caller may no longer be looking at, and two
 * people dragging tabs would interleave into an order neither of them chose.
 */
export async function reorderProjectViews(
  ctx: RequestContext,
  input: ReorderProjectViewsInput,
): Promise<
  Result<
    ProjectViewDto[],
    typeof CommonErrorCode.NotFound | typeof CommonErrorCode.ValidationFailed
  >
> {
  if (!(await ownsProject(ctx, input.projectId))) return err(CommonErrorCode.NotFound);

  const existing = await listProjectViews(ctx, input.projectId);
  const asked = new Set(input.viewIds);
  if (asked.size !== input.viewIds.length) return err(CommonErrorCode.ValidationFailed);
  if (asked.size !== existing.length || existing.some((view) => !asked.has(view.id))) {
    return err(CommonErrorCode.ValidationFailed);
  }

  const now = new Date().toISOString();
  for (const [position, viewId] of input.viewIds.entries()) {
    await ctx.db
      .update(projectView)
      .set({ position, updatedAt: now })
      .where(and(eq(projectView.workspaceId, ctx.workspaceId), eq(projectView.id, viewId)));
  }
  return ok(await listProjectViews(ctx, input.projectId));
}

/**
 * Delete a view.
 *
 * Nothing else goes with it, and that is the point: a tab is a saved question, and deleting a
 * question does not delete what it was asked about. The rows it selected are the Project's.
 */
export async function deleteProjectView(
  ctx: RequestContext,
  viewId: string,
): Promise<Result<{ id: string }, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .delete(projectView)
    .where(and(eq(projectView.workspaceId, ctx.workspaceId), eq(projectView.id, viewId)))
    .returning({ id: projectView.id });
  if (!row) return err(CommonErrorCode.NotFound);
  return ok({ id: row.id });
}
