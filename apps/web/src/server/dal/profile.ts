import "server-only";
import {
  type AgentCatalogEntryDto,
  AgentCatalogErrorCode,
  type AgentProfileDto,
  AgentProfileErrorCode,
  type AgentProfileUsageDto,
  CommonErrorCode,
  type CreateAgentCatalogEntryInput,
  type CreateAgentProfileInput,
  type CreateExecutorProfileInput,
  type DeleteAgentProfileInput,
  type ExecutorProfileDto,
  err,
  ok,
  type Result,
  type UpdateAgentProfileInput,
  type UpdateExecutorProfileInput,
} from "@gatecontrol/contracts";
import {
  agentCatalog,
  agentProfile,
  executorProfile,
  sessionUsage,
  task,
  workflowStep,
} from "@gatecontrol/db";
import { and, desc, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";

export async function listAgentCatalog(
  ctx: RequestContext,
): Promise<Result<AgentCatalogEntryDto[]>> {
  const rows = await ctx.db
    .select()
    .from(agentCatalog)
    .where(eq(agentCatalog.workspaceId, ctx.workspaceId))
    .orderBy(desc(agentCatalog.createdAt));
  return ok(rows);
}

/**
 * Declare a new agent this Workspace can run (spec F05 AC-1, issue #10/#58).
 *
 * Every Workspace is seeded with exactly one row — `claude_code`, `claude_code_stream_json` —
 * by `ensureDefaultAgentCatalog`, and until now that was the only one that could ever exist:
 * nothing wrote a second row. That mattered beyond convenience — `acp` already has a real
 * runner (`acp-runner.ts`) implementing the full `session/request_permission` round trip an
 * elicitation widget needs, but with no way to add an `acp`-protocol row, no Agent Profile could
 * ever point at it, so the runner it already has could never actually run.
 *
 * `key` is checked for uniqueness explicitly rather than left to the `(workspace_id, key)`
 * index: the raw constraint error names a column, not the row the Owner was trying to add.
 */
export async function createAgentCatalogEntry(
  ctx: RequestContext,
  input: CreateAgentCatalogEntryInput,
): Promise<
  Result<
    AgentCatalogEntryDto,
    typeof AgentCatalogErrorCode.KeyTaken | typeof CommonErrorCode.ValidationFailed
  >
> {
  const [existing] = await ctx.db
    .select({ id: agentCatalog.id })
    .from(agentCatalog)
    .where(and(eq(agentCatalog.workspaceId, ctx.workspaceId), eq(agentCatalog.key, input.key)))
    .limit(1);
  if (existing) return err(AgentCatalogErrorCode.KeyTaken);

  const [row] = await ctx.db
    .insert(agentCatalog)
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

export async function createAgentProfile(
  ctx: RequestContext,
  input: CreateAgentProfileInput,
): Promise<Result<AgentProfileDto>> {
  // The FK alone only proves the catalog row exists *somewhere* — without this check, an
  // Agent Profile could point at another Workspace's catalog entry and inherit its launch
  // command and billing variable names (Principle V).
  const [entry] = await ctx.db
    .select({ id: agentCatalog.id })
    .from(agentCatalog)
    .where(
      and(eq(agentCatalog.workspaceId, ctx.workspaceId), eq(agentCatalog.id, input.agentCatalogId)),
    )
    .limit(1);
  if (!entry) return err(CommonErrorCode.ValidationFailed);

  const [row] = await ctx.db
    .insert(agentProfile)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      agentCatalogId: input.agentCatalogId,
      authMode: input.authMode,
      secretId: input.secretId,
      concurrencyCap: input.concurrencyCap,
      permissionMode: input.permissionMode,
    })
    .returning();
  // A Profile just created cannot be referenced by anything yet — nothing existed a statement
  // ago that could point at this id.
  return row ? ok({ ...row, usage: EMPTY_USAGE }) : err(CommonErrorCode.ValidationFailed);
}

/** An Agent Profile referenced by nothing yet — every count zero, computed rather than guessed. */
const EMPTY_USAGE: AgentProfileUsageDto = {
  taskCount: 0,
  workflowStepCount: 0,
  sessionUsageCount: 0,
};

/**
 * How many Tasks, Workflow Steps, and Session usage records reference each Agent Profile in this
 * Workspace, batched into one pass per table rather than one query per Profile (the list view
 * renders every Profile at once, so an N+1 here would be one query per row on every Settings
 * load).
 *
 * Counted in application code, not with a SQL `count() ... group by`: nothing else in this DAL
 * uses a SQL aggregate, every sibling "how many/which rows reference this" query here fetches
 * the bare ids and reduces them in a `Map` (see `taskStatesByIssue`, `attachmentsForTasks`), and
 * a Workspace's own Profile list is never large enough for that difference to matter.
 */
async function loadAgentProfileUsage(
  ctx: RequestContext,
): Promise<Map<string, AgentProfileUsageDto>> {
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

  const usage = new Map<string, AgentProfileUsageDto>();
  const bump = (id: string, key: keyof AgentProfileUsageDto) => {
    const existing = usage.get(id) ?? { ...EMPTY_USAGE };
    existing[key] += 1;
    usage.set(id, existing);
  };
  for (const row of tasks) bump(row.agentProfileId, "taskCount");
  for (const row of steps) bump(row.agentProfileId, "workflowStepCount");
  for (const row of usages) bump(row.agentProfileId, "sessionUsageCount");
  return usage;
}

export async function listAgentProfiles(ctx: RequestContext): Promise<Result<AgentProfileDto[]>> {
  const [rows, usage] = await Promise.all([
    ctx.db
      .select()
      .from(agentProfile)
      .where(eq(agentProfile.workspaceId, ctx.workspaceId))
      .orderBy(desc(agentProfile.createdAt)),
    loadAgentProfileUsage(ctx),
  ]);
  return ok(rows.map((row) => ({ ...row, usage: usage.get(row.id) ?? EMPTY_USAGE })));
}

export async function getAgentProfile(
  ctx: RequestContext,
  id: string,
): Promise<Result<AgentProfileDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(agentProfile)
    .where(and(eq(agentProfile.workspaceId, ctx.workspaceId), eq(agentProfile.id, id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  const usage = await loadAgentProfileUsage(ctx);
  return ok({ ...row, usage: usage.get(row.id) ?? EMPTY_USAGE });
}

/**
 * Delete an Agent Profile, refused while a Task, a Workflow Step, or a Session usage record
 * still references it (spec F05/F06). All three are NOT NULL foreign keys — unlike a Secret's
 * `secret_id`, a plain column — so an unrefused delete would not silently orphan anything; it
 * would throw a raw SQLite constraint error from deep inside the delete statement. Checking
 * first turns that into the same ordinary, explained refusal `secret.delete` already gives.
 */
/**
 * Edit a Profile's name, concurrency cap or permission mode.
 *
 * Deliberately not a general update: `agentCatalogId`, `authMode` and `secretId` are what a
 * Profile *is*, and every Task that ran under it was launched with them. Changing which agent it
 * runs, or which credential it runs on, would rewrite what a finished run meant.
 *
 * The permission mode is different — it applies to the *next* launch and nothing already
 * recorded, which is exactly why it is editable at all: the Owner who discovers mid-project that
 * their agent cannot reach the shell should not have to delete the Profile (and orphan its
 * history) to fix it.
 */
export async function updateAgentProfile(
  ctx: RequestContext,
  input: UpdateAgentProfileInput,
): Promise<Result<AgentProfileDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(agentProfile)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.concurrencyCap !== undefined ? { concurrencyCap: input.concurrencyCap } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(agentProfile.workspaceId, ctx.workspaceId), eq(agentProfile.id, input.id)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  const usage = await loadAgentProfileUsage(ctx);
  return ok({ ...row, usage: usage.get(row.id) ?? EMPTY_USAGE });
}

export async function deleteAgentProfile(
  ctx: RequestContext,
  input: DeleteAgentProfileInput,
): Promise<
  Result<AgentProfileDto, typeof CommonErrorCode.NotFound | typeof AgentProfileErrorCode.InUse>
> {
  const [row] = await ctx.db
    .select()
    .from(agentProfile)
    .where(and(eq(agentProfile.workspaceId, ctx.workspaceId), eq(agentProfile.id, input.id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const usage = (await loadAgentProfileUsage(ctx)).get(row.id) ?? EMPTY_USAGE;
  if (usage.taskCount > 0 || usage.workflowStepCount > 0 || usage.sessionUsageCount > 0) {
    return err(AgentProfileErrorCode.InUse);
  }

  await ctx.db
    .delete(agentProfile)
    .where(and(eq(agentProfile.workspaceId, ctx.workspaceId), eq(agentProfile.id, row.id)));
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
): Promise<Result<ExecutorProfileDto[]>> {
  const rows = await ctx.db
    .select()
    .from(executorProfile)
    .where(eq(executorProfile.workspaceId, ctx.workspaceId))
    .orderBy(desc(executorProfile.createdAt));
  return ok(rows);
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
