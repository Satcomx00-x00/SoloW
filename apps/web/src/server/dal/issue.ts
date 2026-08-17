import "server-only";
import {
  CommonErrorCode,
  type CreateIssueInput,
  err,
  type IssueDto,
  type IssueListDto,
  type ListIssuesInput,
  ok,
  type Result,
} from "@gatecontrol/contracts";
import { issue, task } from "@gatecontrol/db";
import { and, count, desc, eq, like } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { issueToDto } from "./mappers.js";

/** Count Tasks for an Issue within the Workspace. */
async function taskCountFor(ctx: RequestContext, issueId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.issueId, issueId)));
  return row?.n ?? 0;
}

export async function getIssueById(
  ctx: RequestContext,
  id: string,
): Promise<Result<IssueDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(issue)
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  return ok(issueToDto(row, await taskCountFor(ctx, row.id)));
}

export async function listIssues(
  ctx: RequestContext,
  input: ListIssuesInput,
): Promise<Result<IssueListDto>> {
  const conditions = [eq(issue.workspaceId, ctx.workspaceId)];
  if (input.status) conditions.push(eq(issue.status, input.status));
  if (input.query) conditions.push(like(issue.title, `%${input.query}%`));

  const rows = await ctx.db
    .select()
    .from(issue)
    .where(and(...conditions))
    .orderBy(desc(issue.createdAt));

  const dtos = await Promise.all(
    rows.map(async (r) => issueToDto(r, await taskCountFor(ctx, r.id))),
  );
  return ok(dtos);
}

export async function createIssueRecord(
  ctx: RequestContext,
  input: CreateIssueInput,
): Promise<Result<IssueDto>> {
  const [row] = await ctx.db
    .insert(issue)
    .values({
      workspaceId: ctx.workspaceId,
      title: input.title,
      description: input.description ?? null,
    })
    .returning();
  if (!row) return err(CommonErrorCode.ValidationFailed);
  return ok(issueToDto(row, 0));
}
