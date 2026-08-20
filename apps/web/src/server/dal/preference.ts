import "server-only";
import {
  DEFAULT_SURFACE_LAYOUT,
  ok,
  type Result,
  type SetSurfaceLayoutInput,
  type SurfaceKey,
  type SurfaceLayout,
  type SurfaceLayoutDto,
  surfaceLayoutPreferenceKey,
  surfaceLayoutSchema,
} from "@gatecontrol/contracts";
import { uiPreference } from "@gatecontrol/db";
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
