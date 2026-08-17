import "server-only";
import { desc, eq } from "drizzle-orm";
import {
  type ConnectRepositoryInput,
  type RepositoryDto,
  type Result,
  CommonErrorCode,
  err,
  ok,
} from "@gatecontrol/contracts";
import { repository } from "@gatecontrol/db";
import type { RequestContext } from "./context.js";
import { repositoryToDto } from "./mappers.js";

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

export async function listRepositories(
  ctx: RequestContext,
): Promise<Result<RepositoryDto[]>> {
  const rows = await ctx.db
    .select()
    .from(repository)
    .where(eq(repository.workspaceId, ctx.workspaceId))
    .orderBy(desc(repository.createdAt));
  return ok(rows.map(repositoryToDto));
}
