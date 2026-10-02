import "server-only";
import {
  CommonErrorCode,
  type CreateHarnessConfigInput,
  err,
  freeCopyName,
  type HarnessConfigDocument,
  type HarnessConfigDto,
  HarnessConfigErrorCode,
  type ListHarnessConfigsInput,
  ok,
  type Result,
  toHarnessConfigDocument,
  type UpdateHarnessConfigInput,
} from "@solow/contracts";
import { harnessConfig, harnessProfile } from "@solow/db";
import { and, asc, eq, ne } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * Harness Configs (Decision 0028): the harness's own JSON configuration, stored per Workspace.
 *
 * Every statement is filtered on `ctx.workspaceId` (Principle V). The content is checked by the
 * input schemas (`harnessConfigViolations`) before it gets here, so nothing in this file has to
 * know what a Claude Code or opencode config may say.
 */

type NotFound = typeof CommonErrorCode.NotFound;
type Row = typeof harnessConfig.$inferSelect;

const now = () => new Date().toISOString();
const scoped = (ctx: RequestContext, id: string) =>
  and(eq(harnessConfig.workspaceId, ctx.workspaceId), eq(harnessConfig.id, id));

/** How many Profiles select each config — one pass, not one query per row. */
async function profileCounts(ctx: RequestContext): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({ id: harnessProfile.harnessConfigId })
    .from(harnessProfile)
    .where(eq(harnessProfile.workspaceId, ctx.workspaceId));
  const counts = new Map<string, number>();
  for (const { id } of rows) if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

const toDto = (row: Row, profileCount: number): HarnessConfigDto => ({
  id: row.id,
  name: row.name,
  description: row.description,
  harness: row.harness,
  content: row.content,
  profileCount,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

async function nameTaken(ctx: RequestContext, name: string, except?: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: harnessConfig.id })
    .from(harnessConfig)
    .where(
      and(
        eq(harnessConfig.workspaceId, ctx.workspaceId),
        eq(harnessConfig.name, name),
        ...(except ? [ne(harnessConfig.id, except)] : []),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function takenNames(ctx: RequestContext): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ name: harnessConfig.name })
    .from(harnessConfig)
    .where(eq(harnessConfig.workspaceId, ctx.workspaceId));
  return new Set(rows.map((r) => r.name));
}

async function getRow(ctx: RequestContext, id: string): Promise<Row | undefined> {
  const [row] = await ctx.db.select().from(harnessConfig).where(scoped(ctx, id)).limit(1);
  return row;
}

export async function listHarnessConfigs(
  ctx: RequestContext,
  input: ListHarnessConfigsInput,
): Promise<Result<HarnessConfigDto[]>> {
  const [rows, counts] = await Promise.all([
    ctx.db
      .select()
      .from(harnessConfig)
      .where(
        and(
          eq(harnessConfig.workspaceId, ctx.workspaceId),
          ...(input.harness ? [eq(harnessConfig.harness, input.harness)] : []),
        ),
      )
      .orderBy(asc(harnessConfig.name)),
    profileCounts(ctx),
  ]);
  return ok(rows.map((row) => toDto(row, counts.get(row.id) ?? 0)));
}

export async function getHarnessConfig(
  ctx: RequestContext,
  id: string,
): Promise<Result<HarnessConfigDto, NotFound>> {
  const row = await getRow(ctx, id);
  if (!row) return err(CommonErrorCode.NotFound);
  return ok(toDto(row, (await profileCounts(ctx)).get(row.id) ?? 0));
}

async function insert(
  ctx: RequestContext,
  values: Omit<CreateHarnessConfigInput, "description"> & { description: string | null },
): Promise<Result<HarnessConfigDto, typeof CommonErrorCode.ValidationFailed>> {
  const [row] = await ctx.db
    .insert(harnessConfig)
    .values({ workspaceId: ctx.workspaceId, ...values })
    .returning();
  return row ? ok(toDto(row, 0)) : err(CommonErrorCode.ValidationFailed);
}

export async function createHarnessConfig(
  ctx: RequestContext,
  input: CreateHarnessConfigInput,
): Promise<
  Result<
    HarnessConfigDto,
    typeof HarnessConfigErrorCode.NameTaken | typeof CommonErrorCode.ValidationFailed
  >
> {
  if (await nameTaken(ctx, input.name)) return err(HarnessConfigErrorCode.NameTaken);
  return insert(ctx, { ...input, description: input.description?.trim() || null });
}

export async function updateHarnessConfig(
  ctx: RequestContext,
  input: UpdateHarnessConfigInput,
): Promise<
  Result<
    HarnessConfigDto,
    | NotFound
    | typeof HarnessConfigErrorCode.NameTaken
    | typeof HarnessConfigErrorCode.HarnessMismatch
  >
> {
  const existing = await getRow(ctx, input.id);
  if (!existing) return err(CommonErrorCode.NotFound);
  // `harness` is restated so the input schema could check `content` against it; it never changes.
  if (existing.harness !== input.harness) return err(HarnessConfigErrorCode.HarnessMismatch);
  if (input.name !== undefined && (await nameTaken(ctx, input.name, input.id))) {
    return err(HarnessConfigErrorCode.NameTaken);
  }
  const [row] = await ctx.db
    .update(harnessConfig)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description?.trim() || null }
        : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      updatedAt: now(),
    })
    .where(scoped(ctx, input.id))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  return ok(toDto(row, (await profileCounts(ctx)).get(row.id) ?? 0));
}

/** A copy to change without changing what the original's Profiles launch with. */
export async function duplicateHarnessConfig(
  ctx: RequestContext,
  input: { id: string; name?: string | undefined },
): Promise<
  Result<
    HarnessConfigDto,
    NotFound | typeof HarnessConfigErrorCode.NameTaken | typeof CommonErrorCode.ValidationFailed
  >
> {
  const source = await getRow(ctx, input.id);
  if (!source) return err(CommonErrorCode.NotFound);
  if (input.name !== undefined && (await nameTaken(ctx, input.name))) {
    return err(HarnessConfigErrorCode.NameTaken);
  }
  return insert(ctx, {
    name: input.name ?? freeCopyName(source.name, await takenNames(ctx)),
    description: source.description,
    harness: source.harness,
    content: source.content,
  });
}

/** Refused while a Profile selects it: deleting it would silently change what that Profile runs. */
export async function deleteHarnessConfig(
  ctx: RequestContext,
  id: string,
): Promise<Result<HarnessConfigDto, NotFound | typeof HarnessConfigErrorCode.InUse>> {
  const row = await getRow(ctx, id);
  if (!row) return err(CommonErrorCode.NotFound);
  const count = (await profileCounts(ctx)).get(row.id) ?? 0;
  if (count > 0) return err(HarnessConfigErrorCode.InUse);
  await ctx.db.delete(harnessConfig).where(scoped(ctx, id));
  return ok(toDto(row, 0));
}

export async function exportHarnessConfig(
  ctx: RequestContext,
  id: string,
): Promise<Result<HarnessConfigDocument, NotFound>> {
  const row = await getRow(ctx, id);
  return row ? ok(toHarnessConfigDocument(row)) : err(CommonErrorCode.NotFound);
}

/** A shared config lands beside the Workspace's own; a taken name gets a "(copy)" suffix. */
export async function importHarnessConfig(
  ctx: RequestContext,
  document: HarnessConfigDocument,
): Promise<Result<HarnessConfigDto, typeof CommonErrorCode.ValidationFailed>> {
  return insert(ctx, {
    name: freeCopyName(document.name, await takenNames(ctx)),
    description: document.description,
    harness: document.harness,
    content: document.content,
  });
}
