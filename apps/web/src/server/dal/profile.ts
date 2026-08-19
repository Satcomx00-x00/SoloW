import "server-only";
import {
  type AgentCatalogEntryDto,
  type AgentProfileDto,
  CommonErrorCode,
  type CreateAgentProfileInput,
  type CreateExecutorProfileInput,
  type ExecutorProfileDto,
  err,
  ok,
  type Result,
} from "@gatecontrol/contracts";
import { agentCatalog, agentProfile, executorProfile } from "@gatecontrol/db";
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

export async function createExecutorProfile(
  ctx: RequestContext,
  input: CreateExecutorProfileInput,
): Promise<Result<ExecutorProfileDto>> {
  const [row] = await ctx.db
    .insert(executorProfile)
    .values({ workspaceId: ctx.workspaceId, name: input.name, kind: input.kind })
    .returning();
  return row ? ok(row) : err(CommonErrorCode.ValidationFailed);
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
