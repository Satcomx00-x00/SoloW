import "server-only";
import {
  type AgentProfileDto,
  CommonErrorCode,
  type CreateAgentProfileInput,
  type CreateExecutorProfileInput,
  type ExecutorProfileDto,
  err,
  ok,
  type Result,
  type UpdateExecutorProfileInput,
} from "@gatecontrol/contracts";
import { agentProfile, executorProfile } from "@gatecontrol/db";
import { and, desc, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";

export async function createAgentProfile(
  ctx: RequestContext,
  input: CreateAgentProfileInput,
): Promise<Result<AgentProfileDto>> {
  const [row] = await ctx.db
    .insert(agentProfile)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      agentKind: input.agentKind,
      authMode: input.authMode,
      secretId: input.secretId,
      concurrencyCap: input.concurrencyCap,
    })
    .returning();
  return row ? ok(row) : err(CommonErrorCode.ValidationFailed);
}

export async function listAgentProfiles(ctx: RequestContext): Promise<Result<AgentProfileDto[]>> {
  const rows = await ctx.db
    .select()
    .from(agentProfile)
    .where(eq(agentProfile.workspaceId, ctx.workspaceId))
    .orderBy(desc(agentProfile.createdAt));
  return ok(rows);
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
  return row ? ok(row) : err(CommonErrorCode.NotFound);
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
