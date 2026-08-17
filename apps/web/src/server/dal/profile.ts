import "server-only";
import { and, desc, eq } from "drizzle-orm";
import {
  type AgentProfileDto,
  type CreateAgentProfileInput,
  type CreateExecutorProfileInput,
  type ExecutorProfileDto,
  type Result,
  CommonErrorCode,
  err,
  ok,
} from "@gatecontrol/contracts";
import { agentProfile, executorProfile } from "@gatecontrol/db";
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

export async function listAgentProfiles(
  ctx: RequestContext,
): Promise<Result<AgentProfileDto[]>> {
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
