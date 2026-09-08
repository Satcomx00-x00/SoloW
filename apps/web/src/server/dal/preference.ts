import "server-only";
import {
  DEFAULT_SURFACE_LAYOUT,
  DEFAULT_TASK_PANE_LAYOUT,
  ok,
  RECENT_TASKS_MAX,
  RECENT_TASKS_PREFERENCE_KEY,
  type RecentTasksDto,
  type Result,
  recentTaskIdsSchema,
  type SetSurfaceLayoutInput,
  type SurfaceKey,
  type SurfaceLayout,
  type SurfaceLayoutDto,
  surfaceLayoutPreferenceKey,
  surfaceLayoutSchema,
  TASK_PANE_PREFERENCE_KEY,
  type TaskPaneLayout,
  type TaskPaneLayoutDto,
  taskPaneLayoutSchema,
} from "@solow/contracts";
import { uiPreference } from "@solow/db";
import { and, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * Per-user interface preferences (issue #3, AC-3) — currently the arrangement of a contributed
 * surface: which status-bar segments a user shows, and in what order.
 *
 * Both functions take the Workspace and the user from the RequestContext and never from input
 * (Principle V): the tenant and the person are facts about the session, so there is no argument
 * a client could send that would address another user's row. That is also why the DTO echoes
 * both back — the client keys its cache by the identity the server states rather than by one it
 * inferred.
 *
 * A stored value is parsed on the way out and degrades to the default arrangement when it no
 * longer matches its contract. A preference is convenience state; a row written by an older
 * build, or by hand, must not be able to stop the shell rendering (F19, edge cases).
 */

function dtoFor(ctx: RequestContext, surface: SurfaceKey, layout: SurfaceLayout): SurfaceLayoutDto {
  return { surface, workspaceId: ctx.workspaceId, userId: ctx.userId, layout };
}

export async function getSurfaceLayout(
  ctx: RequestContext,
  surface: SurfaceKey,
): Promise<Result<SurfaceLayoutDto>> {
  const [row] = await ctx.db
    .select({ value: uiPreference.value })
    .from(uiPreference)
    .where(
      and(
        eq(uiPreference.workspaceId, ctx.workspaceId),
        eq(uiPreference.userId, ctx.userId),
        eq(uiPreference.key, surfaceLayoutPreferenceKey(surface)),
      ),
    )
    .limit(1);

  const parsed = surfaceLayoutSchema.safeParse(row?.value);
  return ok(dtoFor(ctx, surface, parsed.success ? parsed.data : DEFAULT_SURFACE_LAYOUT));
}

/**
 * Upsert rather than read-then-insert: the unique index on (workspace_id, user_id, key) is what
 * makes "the user's arrangement" a single answer, and letting the database enforce it means two
 * tabs saving at once cannot produce two rows.
 */
export async function setSurfaceLayout(
  ctx: RequestContext,
  input: SetSurfaceLayoutInput,
): Promise<Result<SurfaceLayoutDto>> {
  const now = new Date().toISOString();
  await ctx.db
    .insert(uiPreference)
    .values({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      key: surfaceLayoutPreferenceKey(input.surface),
      value: input.layout,
    })
    .onConflictDoUpdate({
      target: [uiPreference.workspaceId, uiPreference.userId, uiPreference.key],
      set: { value: input.layout, updatedAt: now },
    });

  return ok(dtoFor(ctx, input.surface, input.layout));
}

/**
 * The Task page's split — the same read-parse-or-default and upsert shape as the surface layout
 * above, for the same reasons. Kept as its own pair rather than generalised into a key/value
 * helper: two callers is not yet a pattern, and a generic setter would be a place for any future
 * client to write any shape under any key.
 */
export async function getTaskPaneLayout(ctx: RequestContext): Promise<Result<TaskPaneLayoutDto>> {
  const [row] = await ctx.db
    .select({ value: uiPreference.value })
    .from(uiPreference)
    .where(
      and(
        eq(uiPreference.workspaceId, ctx.workspaceId),
        eq(uiPreference.userId, ctx.userId),
        eq(uiPreference.key, TASK_PANE_PREFERENCE_KEY),
      ),
    )
    .limit(1);

  // A row written by an older build, or by hand, must not be able to stop the page rendering.
  const parsed = taskPaneLayoutSchema.safeParse(row?.value);
  return ok({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    layout: parsed.success ? parsed.data : DEFAULT_TASK_PANE_LAYOUT,
  });
}

export async function setTaskPaneLayout(
  ctx: RequestContext,
  layout: TaskPaneLayout,
): Promise<Result<TaskPaneLayoutDto>> {
  const now = new Date().toISOString();
  await ctx.db
    .insert(uiPreference)
    .values({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      key: TASK_PANE_PREFERENCE_KEY,
      value: layout,
    })
    .onConflictDoUpdate({
      target: [uiPreference.workspaceId, uiPreference.userId, uiPreference.key],
      set: { value: layout, updatedAt: now },
    });

  return ok({ workspaceId: ctx.workspaceId, userId: ctx.userId, layout });
}

/**
 * The sidebar's memory of which Tasks you were just on (spec F03 follow-on) — the same
 * read-parse-or-default shape as the pair above, degrading to an empty list rather than failing
 * the read for the same reason: a corrupt or stale row is a lost convenience, not an outage.
 */
export async function getRecentTasks(ctx: RequestContext): Promise<Result<RecentTasksDto>> {
  const [row] = await ctx.db
    .select({ value: uiPreference.value })
    .from(uiPreference)
    .where(
      and(
        eq(uiPreference.workspaceId, ctx.workspaceId),
        eq(uiPreference.userId, ctx.userId),
        eq(uiPreference.key, RECENT_TASKS_PREFERENCE_KEY),
      ),
    )
    .limit(1);

  const parsed = recentTaskIdsSchema.safeParse(row?.value);
  return ok({
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    taskIds: parsed.success ? parsed.data : [],
  });
}

/**
 * Move a Task to the front of the list, deduplicated, capped at `RECENT_TASKS_MAX`.
 *
 * Read-modify-write rather than an upsert with a database-side array operation: sqlite has none,
 * and the list is short enough (five ids) that the round trip costs nothing next to the request
 * it rides in on — recording a visit happens once per Task page mount, never in a loop. A race
 * between two tabs recording different Tasks in the same instant can only ever reorder which of
 * the two ends up first; neither is dropped, because each write starts from what the other one
 * left, one request later.
 */
export async function recordRecentTask(
  ctx: RequestContext,
  taskId: string,
): Promise<Result<RecentTasksDto>> {
  const current = await getRecentTasks(ctx);
  if (!current.ok) return current;

  const next = [taskId, ...current.data.taskIds.filter((id) => id !== taskId)].slice(
    0,
    RECENT_TASKS_MAX,
  );
  const now = new Date().toISOString();
  await ctx.db
    .insert(uiPreference)
    .values({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      key: RECENT_TASKS_PREFERENCE_KEY,
      value: next,
    })
    .onConflictDoUpdate({
      target: [uiPreference.workspaceId, uiPreference.userId, uiPreference.key],
      set: { value: next, updatedAt: now },
    });

  return ok({ workspaceId: ctx.workspaceId, userId: ctx.userId, taskIds: next });
}
