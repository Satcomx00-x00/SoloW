import "server-only";
import {
  CommonErrorCode,
  type CreateTaskInput,
  err,
  type ListTasksInput,
  ok,
  type Result,
  type TaskDto,
  type TaskListDto,
  type TaskState,
} from "@gatecontrol/contracts";
import { task } from "@gatecontrol/db";
import { and, desc, eq, like } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { taskToDto } from "./mappers.js";

export async function getTaskById(
  ctx: RequestContext,
  id: string,
): Promise<Result<TaskDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  return ok(taskToDto(row));
}

export async function listTasks(
  ctx: RequestContext,
  input: ListTasksInput,
): Promise<Result<TaskListDto>> {
  const conditions = [eq(task.workspaceId, ctx.workspaceId)];
  if (input.issueId) conditions.push(eq(task.issueId, input.issueId));
  if (input.state) conditions.push(eq(task.state, input.state));
  // `query` was accepted by the input schema and then dropped on the floor, so a filtered
  // request came back unfiltered and looked like it had worked. Matches `listIssues`.
  if (input.query) conditions.push(like(task.title, `%${input.query}%`));

  const rows = await ctx.db
    .select()
    .from(task)
    .where(and(...conditions))
    .orderBy(desc(task.createdAt));
  return ok(rows.map(taskToDto));
}

export async function createTaskRecord(
  ctx: RequestContext,
  input: CreateTaskInput & { state: TaskState },
): Promise<Result<TaskDto>> {
  const [row] = await ctx.db
    .insert(task)
    .values({
      workspaceId: ctx.workspaceId,
      issueId: input.issueId,
      title: input.title,
      state: input.state,
      agentProfileId: input.agentProfileId,
      executorProfileId: input.executorProfileId,
      repositoryId: input.repositoryId,
      baseRef: input.baseRef ?? null,
    })
    .returning();
  if (!row) return err(CommonErrorCode.ValidationFailed);
  return ok(taskToDto(row));
}

/** Update a Task's state (callers gate the transition via services.canTransitionTask). */
export async function updateTaskState(
  ctx: RequestContext,
  id: string,
  state: TaskState,
  extra?: { resultBranch?: string; failureReason?: string | null },
): Promise<Result<TaskDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(task)
    .set({
      state,
      ...(extra?.resultBranch !== undefined ? { resultBranch: extra.resultBranch } : {}),
      ...(extra?.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, id)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  return ok(taskToDto(row));
}

/** Count a profile's Tasks currently in `running` (for the concurrency cap). */
export async function countRunningForAgentProfile(
  ctx: RequestContext,
  agentProfileId: string,
): Promise<number> {
  const rows = await ctx.db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.workspaceId, ctx.workspaceId),
        eq(task.agentProfileId, agentProfileId),
        eq(task.state, "running"),
      ),
    );
  return rows.length;
}
