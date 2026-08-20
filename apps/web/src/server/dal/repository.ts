import "server-only";
import {
  CommonErrorCode,
  type ConnectRepositoryInput,
  err,
  ok,
  type RepositoryDto,
  type Result,
  type UpdateRepositorySetupInput,
} from "@gatecontrol/contracts";
import { repository } from "@gatecontrol/db";
import { and, desc, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { repositoryToDto } from "./mappers.js";

export async function getRepository(
  ctx: RequestContext,
  id: string,
): Promise<Result<RepositoryDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, id)))
    .limit(1);
  return row ? ok(repositoryToDto(row)) : err(CommonErrorCode.NotFound);
}

export async function connectRepository(
  ctx: RequestContext,
  input: ConnectRepositoryInput,
): Promise<Result<RepositoryDto>> {
  const [row] = await ctx.db
    .insert(repository)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      source: input.source,
      location: input.location,
    })
    .returning();
  return row ? ok(repositoryToDto(row)) : err(CommonErrorCode.ValidationFailed);
}

export async function listRepositories(ctx: RequestContext): Promise<Result<RepositoryDto[]>> {
  const rows = await ctx.db
    .select()
    .from(repository)
    .where(eq(repository.workspaceId, ctx.workspaceId))
    .orderBy(desc(repository.createdAt));
  return ok(rows.map(repositoryToDto));
}

/**
 * Replace a Repository's setup-file allowlist (issue #52).
 *
 * Scoped by `workspaceId` in the `where`, like every other write here: the allowlist decides
 * which files are copied into a worktree, so letting one Workspace edit another's would be a
 * tenancy hole with a credential on the other side of it (Principle V).
 */
export async function updateRepositorySetup(
  ctx: RequestContext,
  input: UpdateRepositorySetupInput,
): Promise<Result<RepositoryDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(repository)
    .set({ setupFilePatterns: input.setupFilePatterns, updatedAt: new Date().toISOString() })
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, input.repositoryId)))
    .returning();
  return row ? ok(repositoryToDto(row)) : err(CommonErrorCode.NotFound);
}
