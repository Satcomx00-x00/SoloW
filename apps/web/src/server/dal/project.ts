import "server-only";
import {
  CommonErrorCode,
  err,
  type ListProjectItemsInput,
  ok,
  type ProjectDto,
  type ProjectFieldDto,
  type ProjectItemDto,
  type ProjectItemPageDto,
  parseProjectFieldValue,
  type Result,
} from "@gatecontrol/contracts";
import { issue, project, projectField, projectItem, projectValue } from "@gatecontrol/db";
import { and, asc, count, eq, gt, inArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * Project planning data access (spec F23, Decision 0018, issue #121).
 *
 * A mirror, never an authority: everything here reads or replaces a cache of what a provider
 * said. Nothing in this file writes to a provider, and nothing decides a value — the drivers do
 * the first and the provider does the second.
 *
 * Workspace-scoped on every read and every write, like the rest of the DAL (Principle V).
 */

function toFieldDto(row: typeof projectField.$inferSelect): ProjectFieldDto {
  return {
    id: row.id,
    providerFieldId: row.providerFieldId,
    name: row.name,
    type: row.type,
    options: row.options,
    iterations: row.iterations,
    position: row.position,
    readOnly: row.readOnly,
    readOnlyReason: row.readOnlyReason,
  };
}

export async function getProject(
  ctx: RequestContext,
  projectId: string,
): Promise<Result<ProjectDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(project)
    .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, projectId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const fields = await ctx.db
    .select()
    .from(projectField)
    .where(and(eq(projectField.workspaceId, ctx.workspaceId), eq(projectField.projectId, row.id)))
    .orderBy(asc(projectField.position));

  const [counted] = await ctx.db
    .select({ n: count() })
    .from(projectItem)
    .where(and(eq(projectItem.workspaceId, ctx.workspaceId), eq(projectItem.projectId, row.id)));

  return ok({
    id: row.id,
    integrationId: row.integrationId,
    providerProjectId: row.providerProjectId,
    title: row.title,
    syncedAt: row.syncedAt,
    itemCount: counted?.n ?? 0,
    fields: fields.map(toFieldDto),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/** Every Project in the Workspace, newest first. Fields are not loaded — `getProject` does that. */
/**
 * Which Project holds this Issue, if any.
 *
 * Exists so a screen reached by a *flat* route — a Task at `/task/:id`, an Issue at
 * `/issues/:id` — can still say where it belongs and offer a way back into it. Those routes stay
 * flat deliberately: a Task outlives the view it was opened from, and burying its id under a
 * Project's would break every link the moment the Issue moved between Projects.
 *
 * The first match when an Issue sits in several. A "back" link has room for one destination, and
 * the alternative — refusing to offer one because the answer is ambiguous — strands the reader
 * on a page with no way out but the browser's own button.
 */
export async function projectIdForIssue(
  ctx: RequestContext,
  issueId: string,
): Promise<string | null> {
  const [row] = await ctx.db
    .select({ projectId: projectItem.projectId })
    .from(projectItem)
    .where(and(eq(projectItem.workspaceId, ctx.workspaceId), eq(projectItem.issueId, issueId)))
    .limit(1);
  return row?.projectId ?? null;
}

export async function listProjects(ctx: RequestContext): Promise<ProjectDto[]> {
  const rows = await ctx.db
    .select()
    .from(project)
    .where(eq(project.workspaceId, ctx.workspaceId))
    .orderBy(asc(project.title));

  // One grouped query for every Project, not one per Project: the hub lists them all, and a
  // count-per-row read would turn opening the front door into N round trips.
  const counts = new Map(
    (
      await ctx.db
        .select({ projectId: projectItem.projectId, n: count() })
        .from(projectItem)
        .where(eq(projectItem.workspaceId, ctx.workspaceId))
        .groupBy(projectItem.projectId)
    ).map((r) => [r.projectId, r.n]),
  );

  return rows.map((row) => ({
    id: row.id,
    integrationId: row.integrationId,
    providerProjectId: row.providerProjectId,
    title: row.title,
    syncedAt: row.syncedAt,
    itemCount: counts.get(row.id) ?? 0,
    fields: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

/**
 * One page of a Project's rows, with their values already parsed against their fields' types.
 *
 * Paged on `position` rather than on an offset: a sync landing between two pages shifts every
 * offset after it, and the reader would skip or repeat a row. A position cursor moves with the
 * data (F23 NFR-1).
 *
 * A value that no longer parses is **absent from the row's map**, not null and not an error
 * (#121 AC-3). The cell renders empty, the row renders, and the rest of the table is unaffected
 * — one bad value inside a virtualized grid must not take the viewport with it.
 */
export async function listProjectItems(
  ctx: RequestContext,
  input: ListProjectItemsInput,
): Promise<Result<ProjectItemPageDto, typeof CommonErrorCode.NotFound>> {
  const owned = await getProject(ctx, input.projectId);
  if (!owned.ok) return err(CommonErrorCode.NotFound);

  const after = input.cursor ? Number.parseInt(input.cursor, 10) : null;
  const scope = and(
    eq(projectItem.workspaceId, ctx.workspaceId),
    eq(projectItem.projectId, input.projectId),
  );
  /**
   * The Issue is joined, not fetched per row: the hierarchy needs the provider's parent id and
   * the provider's state for every row on the page (#127), and a query per row is the thing a
   * mirror exists to avoid (F23 NFR-2). The join is scoped to the Workspace on both sides —
   * `projectItem.issueId` is a foreign key, and Principle V does not stop being true because a
   * key already narrows it.
   */
  const rows = await ctx.db
    .select({
      item: projectItem,
      issueExternalId: issue.externalId,
      parentExternalId: issue.externalParentId,
      repositoryId: issue.repositoryId,
      externalState: issue.externalState,
    })
    .from(projectItem)
    .innerJoin(
      issue,
      and(eq(issue.id, projectItem.issueId), eq(issue.workspaceId, ctx.workspaceId)),
    )
    .where(
      after === null || Number.isNaN(after) ? scope : and(scope, gt(projectItem.position, after)),
    )
    .orderBy(asc(projectItem.position))
    .limit(input.limit);

  const [counted] = await ctx.db.select({ total: count() }).from(projectItem).where(scope);
  const total = counted?.total ?? 0;

  const typeByFieldId = new Map(owned.data.fields.map((f) => [f.id, f.type]));
  const ids = rows.map((r) => r.item.id);
  const values = ids.length
    ? await ctx.db
        .select()
        .from(projectValue)
        .where(
          and(eq(projectValue.workspaceId, ctx.workspaceId), inArray(projectValue.itemId, ids)),
        )
    : [];

  const byItem = new Map<string, ProjectItemDto["values"]>();
  for (const row of values) {
    const type = typeByFieldId.get(row.fieldId);
    // A value whose field is gone is a value with no column to render in. Dropped rather than
    // guessed at: the field list is the authority on what this project holds.
    if (!type) continue;
    const parsed = parseProjectFieldValue(type, row.value);
    if (!parsed) continue;
    const bag = byItem.get(row.itemId) ?? {};
    bag[row.fieldId] = parsed;
    byItem.set(row.itemId, bag);
  }

  const items: ProjectItemDto[] = rows.map((row) => ({
    id: row.item.id,
    providerItemId: row.item.providerItemId,
    issueId: row.item.issueId,
    position: row.item.position,
    archivedAt: row.item.archivedAt,
    values: byItem.get(row.item.id) ?? {},
    issueExternalId: row.issueExternalId,
    parentExternalId: row.parentExternalId,
    repositoryId: row.repositoryId,
    // Only `"closed"` is closed. Null is "the mirror has not been told", which is not done — a
    // row counted as finished on no evidence would inflate an epic's progress (#127 AC-3).
    closed: row.externalState === "closed",
  }));
  const last = rows[rows.length - 1];
  return ok({
    items,
    nextCursor: rows.length === input.limit && last ? String(last.item.position) : null,
    total,
  });
}

/**
 * Replace a Project's field set with what the provider just reported.
 *
 * Keyed on `providerFieldId`, so a renamed field is updated rather than doubled (#121 AC-2, and
 * the reason the provider's id is stored at all). A field the provider no longer reports is
 * removed along with its values — the column is gone, and values with no column are unreadable.
 */
export async function replaceProjectFields(
  ctx: RequestContext,
  projectId: string,
  fields: Array<Omit<ProjectFieldDto, "id">>,
): Promise<void> {
  const existing = await ctx.db
    .select({ id: projectField.id, providerFieldId: projectField.providerFieldId })
    .from(projectField)
    .where(
      and(eq(projectField.workspaceId, ctx.workspaceId), eq(projectField.projectId, projectId)),
    );

  const reported = new Set(fields.map((f) => f.providerFieldId));
  const dropped = existing.filter((row) => !reported.has(row.providerFieldId)).map((r) => r.id);
  if (dropped.length > 0) {
    await ctx.db
      .delete(projectValue)
      .where(
        and(eq(projectValue.workspaceId, ctx.workspaceId), inArray(projectValue.fieldId, dropped)),
      );
    await ctx.db.delete(projectField).where(inArray(projectField.id, dropped));
  }

  for (const field of fields) {
    await ctx.db
      .insert(projectField)
      .values({
        workspaceId: ctx.workspaceId,
        projectId,
        providerFieldId: field.providerFieldId,
        name: field.name,
        type: field.type,
        options: field.options,
        iterations: field.iterations,
        position: field.position,
        readOnly: field.readOnly,
        readOnlyReason: field.readOnlyReason,
      })
      .onConflictDoUpdate({
        target: [projectField.projectId, projectField.providerFieldId],
        set: {
          name: field.name,
          type: field.type,
          options: field.options,
          iterations: field.iterations,
          position: field.position,
          readOnly: field.readOnly,
          readOnlyReason: field.readOnlyReason,
          updatedAt: new Date().toISOString(),
        },
      });
  }
}

/** Record where a paged sync reached, so a restart resumes rather than starting over (AC-5). */
export async function setProjectSyncCursor(
  ctx: RequestContext,
  projectId: string,
  cursor: string | null,
  syncedAt?: string,
): Promise<void> {
  await ctx.db
    .update(project)
    .set({
      syncCursor: cursor,
      ...(syncedAt ? { syncedAt } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, projectId)));
}

/**
 * How many rows one read will walk before it stops and says so.
 *
 * A ceiling rather than a promise of completeness: a project big enough to hit this is a project
 * whose planning has stopped being one screen, and answering "the first 5000" *while saying so*
 * is honest where answering "the first 200" silently is not.
 */
export const PROJECT_ITEM_CEILING = 5000;

/**
 * Every row of a Project, paged internally.
 *
 * This exists because reading one page and answering as though the whole project had been read
 * is wrong in three places at once, and they all look plausible while being wrong: a rollup over
 * the rows that happened to land on page one, a filter that reports its answer as covering the
 * project, and a roadmap missing the bars past the cut. The fix belongs here rather than in each
 * of them — one read that is complete, or that states it is not.
 *
 * The alternative was aggregating in SQL, which would mean a second implementation of the filter
 * language in a second language. This codebase refuses that everywhere else, and the filter is
 * the thing most likely to disagree with itself.
 */
export async function listAllProjectItems(
  ctx: RequestContext,
  projectId: string,
  ceiling: number = PROJECT_ITEM_CEILING,
): Promise<
  Result<
    { items: ProjectItemDto[]; total: number; truncated: boolean },
    typeof CommonErrorCode.NotFound
  >
> {
  const collected: ProjectItemDto[] = [];
  let cursor: string | undefined;
  let total = 0;

  for (;;) {
    const page = await listProjectItems(ctx, {
      projectId,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok) return err(CommonErrorCode.NotFound);
    collected.push(...page.data.items);
    total = page.data.total;
    if (!page.data.nextCursor || collected.length >= ceiling) {
      return {
        ok: true,
        data: {
          items: collected.slice(0, ceiling),
          total,
          // True only when rows were actually left unread — a project of exactly the ceiling is
          // complete, and saying otherwise would be a warning nobody can act on.
          truncated: Boolean(page.data.nextCursor) && collected.length >= ceiling,
        },
      };
    }
    cursor = page.data.nextCursor;
  }
}
