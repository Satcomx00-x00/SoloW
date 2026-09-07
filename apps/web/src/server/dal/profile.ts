import "server-only";
import {
  CommonErrorCode,
  type CreateExecutorProfileInput,
  type CreateHarnessCatalogEntryInput,
  type CreateHarnessProfileInput,
  type DeleteHarnessProfileInput,
  type ExecutorProfileDto,
  type ExecutorProfileListDto,
  err,
  type HarnessCatalogEntryDto,
  HarnessCatalogErrorCode,
  type HarnessProfileDto,
  HarnessProfileErrorCode,
  type HarnessProfileListDto,
  type HarnessProfileUsageDto,
  type ListProfilesInput,
  ok,
  type Result,
  type UpdateExecutorProfileInput,
  type UpdateHarnessProfileInput,
} from "@solow/contracts";
import {
  ensureDefaultWorkflows,
  executorProfile,
  harnessCatalog,
  harnessProfile,
  sessionUsage,
  task,
  workflowStep,
} from "@solow/db";
import { and, desc, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { pageAfter, pageLimit, pageOrder, pageProbe, toPage } from "./page.js";

export async function listHarnessCatalog(
  ctx: RequestContext,
): Promise<Result<HarnessCatalogEntryDto[]>> {
  const rows = await ctx.db
    .select()
    .from(harnessCatalog)
    .where(eq(harnessCatalog.workspaceId, ctx.workspaceId))
    .orderBy(desc(harnessCatalog.createdAt));
  return ok(rows);
}

/**
 * Declare a new harness this Workspace can run (spec F05 AC-1, issue #10/#58).
 *
 * Every Workspace is seeded with exactly one row — `claude_code`, `claude_code_stream_json` —
 * by `ensureDefaultHarnessCatalog`, and until now that was the only one that could ever exist:
 * nothing wrote a second row. That mattered beyond convenience — `acp` already has a real
 * runner (`acp-runner.ts`) implementing the full `session/request_permission` round trip an
 * elicitation widget needs, but with no way to add an `acp`-protocol row, no Harness Profile could
 * ever point at it, so the runner it already has could never actually run.
 *
 * `key` is checked for uniqueness explicitly rather than left to the `(workspace_id, key)`
 * index: the raw constraint error names a column, not the row the Owner was trying to add.
 */
export async function createHarnessCatalogEntry(
  ctx: RequestContext,
  input: CreateHarnessCatalogEntryInput,
): Promise<
  Result<
    HarnessCatalogEntryDto,
    typeof HarnessCatalogErrorCode.KeyTaken | typeof CommonErrorCode.ValidationFailed
  >
> {
  const [existing] = await ctx.db
    .select({ id: harnessCatalog.id })
    .from(harnessCatalog)
    .where(and(eq(harnessCatalog.workspaceId, ctx.workspaceId), eq(harnessCatalog.key, input.key)))
    .limit(1);
  if (existing) return err(HarnessCatalogErrorCode.KeyTaken);

  const [row] = await ctx.db
    .insert(harnessCatalog)
    .values({
      workspaceId: ctx.workspaceId,
      key: input.key,
      displayName: input.displayName,
      protocol: input.protocol,
      command: input.command,
      argsTemplate: input.argsTemplate,
      installHint: input.installHint,
      subscriptionEnvVar: input.subscriptionEnvVar,
      meteredEnvVar: input.meteredEnvVar,
      capabilities: input.capabilities,
    })
    .returning();
  return row ? ok(row) : err(CommonErrorCode.ValidationFailed);
}

export async function createHarnessProfile(
  ctx: RequestContext,
  input: CreateHarnessProfileInput,
): Promise<Result<HarnessProfileDto>> {
  // The FK alone only proves the catalog row exists *somewhere* — without this check, an
  // Harness Profile could point at another Workspace's catalog entry and inherit its launch
  // command and billing variable names (Principle V).
  const [entry] = await ctx.db
    .select({ id: harnessCatalog.id })
    .from(harnessCatalog)
    .where(
      and(
        eq(harnessCatalog.workspaceId, ctx.workspaceId),
        eq(harnessCatalog.id, input.agentCatalogId),
      ),
    )
    .limit(1);
  if (!entry) return err(CommonErrorCode.ValidationFailed);

  const [row] = await ctx.db
    .insert(harnessProfile)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      agentCatalogId: input.agentCatalogId,
      authMode: input.authMode,
      secretId: input.secretId,
      concurrencyCap: input.concurrencyCap,
      permissionMode: input.permissionMode,
      model: input.model,
      modeId: input.modeId,
    })
    .returning();
  // The Workspace's first Profile is what the default Workflows were waiting for: a Step has to
  // name the harness that runs it, so they could not be seeded before one existed (spec F03).
  if (row) await ensureDefaultWorkflows(ctx.db, ctx.workspaceId);
  // A Profile just created cannot be referenced by anything yet — nothing existed a statement
  // ago that could point at this id.
  return row ? ok({ ...row, usage: EMPTY_USAGE }) : err(CommonErrorCode.ValidationFailed);
}

/** A Harness Profile referenced by nothing yet — every count zero, computed rather than guessed. */
const EMPTY_USAGE: HarnessProfileUsageDto = {
  taskCount: 0,
  workflowStepCount: 0,
  sessionUsageCount: 0,
};

/**
 * How many Tasks, Workflow Steps, and Session usage records reference each Harness Profile in this
 * Workspace, batched into one pass per table rather than one query per Profile (the list view
 * renders every Profile at once, so an N+1 here would be one query per row on every Settings
 * load).
 *
 * Counted in application code, not with a SQL `count() ... group by`: nothing else in this DAL
 * uses a SQL aggregate, every sibling "how many/which rows reference this" query here fetches
 * the bare ids and reduces them in a `Map` (see `taskStatesByIssue`, `attachmentsForTasks`), and
 * a Workspace's own Profile list is never large enough for that difference to matter.
 */
async function loadHarnessProfileUsage(
  ctx: RequestContext,
): Promise<Map<string, HarnessProfileUsageDto>> {
  const [tasks, steps, usages] = await Promise.all([
    ctx.db
      .select({ agentProfileId: task.agentProfileId })
      .from(task)
      .where(eq(task.workspaceId, ctx.workspaceId)),
    ctx.db
      .select({ agentProfileId: workflowStep.agentProfileId })
      .from(workflowStep)
      .where(eq(workflowStep.workspaceId, ctx.workspaceId)),
    ctx.db
      .select({ agentProfileId: sessionUsage.agentProfileId })
      .from(sessionUsage)
      .where(eq(sessionUsage.workspaceId, ctx.workspaceId)),
  ]);

  const usage = new Map<string, HarnessProfileUsageDto>();
  const bump = (id: string, key: keyof HarnessProfileUsageDto) => {
    const existing = usage.get(id) ?? { ...EMPTY_USAGE };
    existing[key] += 1;
    usage.set(id, existing);
  };
  for (const row of tasks) bump(row.agentProfileId, "taskCount");
  for (const row of steps) bump(row.agentProfileId, "workflowStepCount");
  for (const row of usages) bump(row.agentProfileId, "sessionUsageCount");
  return usage;
}

export async function listHarnessProfiles(
  ctx: RequestContext,
  input: ListProfilesInput,
): Promise<Result<HarnessProfileListDto>> {
  const after = pageAfter(input.cursor, harnessProfile.createdAt, harnessProfile.id);
  const [rows, usage] = await Promise.all([
    ctx.db
      .select()
      .from(harnessProfile)
      .where(and(eq(harnessProfile.workspaceId, ctx.workspaceId), ...(after ? [after] : [])))
      .orderBy(...pageOrder(harnessProfile.createdAt, harnessProfile.id))
      .limit(pageProbe(pageLimit(input.limit))),
    loadHarnessProfileUsage(ctx),
  ]);
  const page = toPage(rows, pageLimit(input.limit), (row) => ({
    createdAt: row.createdAt,
    id: row.id,
  }));
  return ok({
    items: page.items.map((row) => ({ ...row, usage: usage.get(row.id) ?? EMPTY_USAGE })),
    nextCursor: page.nextCursor,
  });
}

export async function getHarnessProfile(
  ctx: RequestContext,
  id: string,
): Promise<Result<HarnessProfileDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(harnessProfile)
    .where(and(eq(harnessProfile.workspaceId, ctx.workspaceId), eq(harnessProfile.id, id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  const usage = await loadHarnessProfileUsage(ctx);
  return ok({ ...row, usage: usage.get(row.id) ?? EMPTY_USAGE });
}

/**
 * Delete a Harness Profile, refused while a Task, a Workflow Step, or a Session usage record
 * still references it (spec F05/F06). All three are NOT NULL foreign keys — unlike a Secret's
 * `secret_id`, a plain column — so an unrefused delete would not silently orphan anything; it
 * would throw a raw SQLite constraint error from deep inside the delete statement. Checking
 * first turns that into the same ordinary, explained refusal `secret.delete` already gives.
 */
/**
 * Edit a Profile's name, concurrency cap or permission mode.
 *
 * Deliberately not a general update: `agentCatalogId`, `authMode` and `secretId` are what a
 * Profile *is*, and every Task that ran under it was launched with them. Changing which harness it
 * runs, or which credential it runs on, would rewrite what a finished run meant.
 *
 * The permission mode is different — it applies to the *next* launch and nothing already
 * recorded, which is exactly why it is editable at all: the Owner who discovers mid-project that
 * their harness cannot reach the shell should not have to delete the Profile (and orphan its
 * history) to fix it.
 */
export async function updateHarnessProfile(
  ctx: RequestContext,
  input: UpdateHarnessProfileInput,
): Promise<Result<HarnessProfileDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(harnessProfile)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.concurrencyCap !== undefined ? { concurrencyCap: input.concurrencyCap } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      // Absent leaves the pin alone; null clears it back to "whatever the harness chooses".
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.modeId !== undefined ? { modeId: input.modeId } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(harnessProfile.workspaceId, ctx.workspaceId), eq(harnessProfile.id, input.id)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  const usage = await loadHarnessProfileUsage(ctx);
  return ok({ ...row, usage: usage.get(row.id) ?? EMPTY_USAGE });
}

export async function deleteHarnessProfile(
  ctx: RequestContext,
  input: DeleteHarnessProfileInput,
): Promise<
  Result<HarnessProfileDto, typeof CommonErrorCode.NotFound | typeof HarnessProfileErrorCode.InUse>
> {
  const [row] = await ctx.db
    .select()
    .from(harnessProfile)
    .where(and(eq(harnessProfile.workspaceId, ctx.workspaceId), eq(harnessProfile.id, input.id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const usage = (await loadHarnessProfileUsage(ctx)).get(row.id) ?? EMPTY_USAGE;
  if (usage.taskCount > 0 || usage.workflowStepCount > 0 || usage.sessionUsageCount > 0) {
    return err(HarnessProfileErrorCode.InUse);
  }

  await ctx.db
    .delete(harnessProfile)
    .where(and(eq(harnessProfile.workspaceId, ctx.workspaceId), eq(harnessProfile.id, row.id)));
  return ok({ ...row, usage: EMPTY_USAGE });
}

/**
 * `kind` is derived from `config.kind` rather than taken separately (issue #73) — the column is
 * a queryable copy of the configuration, and nothing else may set it.
 */
export async function createExecutorProfile(
  ctx: RequestContext,
  input: CreateExecutorProfileInput,
): Promise<Result<ExecutorProfileDto>> {
  const [row] = await ctx.db
    .insert(executorProfile)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      kind: input.config.kind,
      config: input.config,
    })
    .returning();
  return row ? ok(row) : err(CommonErrorCode.ValidationFailed);
}

export async function updateExecutorProfile(
  ctx: RequestContext,
  input: UpdateExecutorProfileInput,
): Promise<Result<ExecutorProfileDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(executorProfile)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.config !== undefined ? { kind: input.config.kind, config: input.config } : {}),
      updatedAt: new Date().toISOString(),
    })
    // The workspace predicate is the tenancy boundary (Principle V): without it an id from
    // another tenant would update someone else's profile.
    .where(and(eq(executorProfile.workspaceId, ctx.workspaceId), eq(executorProfile.id, input.id)))
    .returning();
  return row ? ok(row) : err(CommonErrorCode.NotFound);
}

export async function listExecutorProfiles(
  ctx: RequestContext,
  input: ListProfilesInput,
): Promise<Result<ExecutorProfileListDto>> {
  const after = pageAfter(input.cursor, executorProfile.createdAt, executorProfile.id);
  const rows = await ctx.db
    .select()
    .from(executorProfile)
    .where(and(eq(executorProfile.workspaceId, ctx.workspaceId), ...(after ? [after] : [])))
    .orderBy(...pageOrder(executorProfile.createdAt, executorProfile.id))
    .limit(pageProbe(pageLimit(input.limit)));
  const page = toPage(rows, pageLimit(input.limit), (row) => ({
    createdAt: row.createdAt,
    id: row.id,
  }));
  return ok({ items: page.items, nextCursor: page.nextCursor });
}

export async function getExecutorProfile(
  ctx: RequestContext,
  id: string,
): Promise<Result<ExecutorProfileDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(executorProfile)
    .where(and(eq(executorProfile.workspaceId, ctx.workspaceId), eq(executorProfile.id, id)))
    .limit(1);
  return row ? ok(row) : err(CommonErrorCode.NotFound);
}
