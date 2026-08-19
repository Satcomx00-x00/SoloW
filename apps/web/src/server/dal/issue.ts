import "server-only";
import {
  CommonErrorCode,
  err,
  type IssueDto,
  type IssueListDto,
  type IssueStatus,
  type ListIssuesInput,
  ok,
  type Result,
  type TaskState,
} from "@gatecontrol/contracts";
import { deriveIssueStatus } from "@gatecontrol/core";
import { issue, task } from "@gatecontrol/db";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { issueToDto } from "./mappers.js";

/**
 * The Task states belonging to each of the given Issues, keyed by Issue id.
 *
 * One query for the whole page rather than one per row: this feeds both the Task count and the
 * derived status, and doing it per Issue made the list N+1.
 */
async function taskStatesByIssue(
  ctx: RequestContext,
  issueIds: string[],
): Promise<Map<string, TaskState[]>> {
  const byIssue = new Map<string, TaskState[]>(issueIds.map((id) => [id, []]));
  if (issueIds.length === 0) return byIssue;

  const rows = await ctx.db
    .select({ issueId: task.issueId, state: task.state })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), inArray(task.issueId, issueIds)));

  for (const row of rows) byIssue.get(row.issueId)?.push(row.state);
  return byIssue;
}

/**
 * An Issue's status is derived from its Tasks (spec FR-006), not read from the column.
 *
 * `deriveIssueStatus` existed in `@gatecontrol/core`, tested, and was never called: the column
 * is written once at creation and never updated, so every Issue read "Open" forever no matter
 * what its Tasks were doing. A stored `closed` still wins, since that is the one status a person
 * sets deliberately to mean "stop tracking this".
 */
function statusFor(stored: IssueStatus, states: TaskState[]): IssueStatus {
  return stored === "closed" ? "closed" : deriveIssueStatus(states);
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
  const states = (await taskStatesByIssue(ctx, [row.id])).get(row.id) ?? [];
  return ok(issueToDto(row, states.length, statusFor(row.status, states)));
}

export async function listIssues(
  ctx: RequestContext,
  input: ListIssuesInput,
): Promise<Result<IssueListDto>> {
  const conditions = [eq(issue.workspaceId, ctx.workspaceId)];
  if (input.query) conditions.push(like(issue.title, `%${input.query}%`));

  const rows = await ctx.db
    .select()
    .from(issue)
    .where(and(...conditions))
    .orderBy(desc(issue.createdAt));

  const states = await taskStatesByIssue(
    ctx,
    rows.map((r) => r.id),
  );
  const dtos = rows.map((r) => {
    const own = states.get(r.id) ?? [];
    return issueToDto(r, own.length, statusFor(r.status, own));
  });

  // Filtered after derivation, not in SQL: the column no longer decides the status, so a
  // `where status = …` would match on a value the caller never sees.
  return ok(input.status ? dtos.filter((d) => d.status === input.status) : dtos);
}
