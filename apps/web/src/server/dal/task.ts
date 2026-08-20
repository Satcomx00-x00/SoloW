import "server-only";
import {
  type AddTaskDependencyInput,
  CommonErrorCode,
  type CreateTaskInput,
  err,
  type ListTaskDependenciesInput,
  type ListTasksInput,
  ok,
  type Result,
  type TaskDependencyCycleError,
  type TaskDependencyListDto,
  type TaskDto,
  type TaskListDto,
  type TaskState,
} from "@gatecontrol/contracts";
import { buildDependencyGraph, checkDependencyEdge } from "@gatecontrol/core";
import { task, taskDependency } from "@gatecontrol/db";
import { and, asc, desc, eq, like } from "drizzle-orm";
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

/**
 * Task dependencies (issue #6). Every question about the *shape* of the graph is still answered
 * in `@gatecontrol/core`, so there is exactly one place cycle detection lives and it is one a
 * test can reach without a database; what happens here is only *when* that answer is asked for —
 * inside the same transaction as the write, which is the part core cannot own.
 *
 * Each query filters on `ctx.workspaceId`, so the graph a Workspace can see, traverse or be
 * refused by is its own (Principle V).
 */

/**
 * A Task's blockers, resolved against `task` so each row carries the blocker's title and state.
 * Omitting `taskId` returns the whole Workspace's edges, which is what the board loads once for
 * every card rather than one query per card.
 */
export async function listTaskDependencies(
  ctx: RequestContext,
  input: ListTaskDependenciesInput,
): Promise<Result<TaskDependencyListDto>> {
  const conditions = [eq(taskDependency.workspaceId, ctx.workspaceId)];
  if (input.taskId) conditions.push(eq(taskDependency.taskId, input.taskId));

  const rows = await ctx.db
    .select({
      taskId: taskDependency.taskId,
      blockedByTaskId: taskDependency.blockedByTaskId,
      blockedByTitle: task.title,
      blockedByState: task.state,
      createdAt: taskDependency.createdAt,
    })
    .from(taskDependency)
    .innerJoin(task, eq(task.id, taskDependency.blockedByTaskId))
    .where(and(...conditions))
    .orderBy(asc(taskDependency.createdAt));
  return ok(rows);
}

/**
 * Record one edge, refusing it if it would close a cycle (AC-2).
 *
 * The check and the insert are one transaction, and every statement inside it is the driver's
 * synchronous form (`.all()`, `.run()`) rather than an awaited query. Both halves of that matter,
 * and for different reasons:
 *
 * - No `await` inside the callback means no other tRPC handler can run between reading the graph
 *   and writing the edge. Two concurrent `task.addDependency` calls asking for `A ← B` and
 *   `B ← A` used to both read the empty graph, both pass the check and both insert, persisting a
 *   two-cycle that nothing ever looks at again — leaving two Tasks that can never start and can
 *   never reach `done` to unblock each other. SQLite's single writer does not help here: it
 *   serializes the writes, not the read→decide→write window in JavaScript.
 * - `BEGIN IMMEDIATE` takes the write lock on the first statement, so the same race across two
 *   connections (the hosted driver of Decision 0008, or a second process on the same file) is
 *   serialized by the database rather than by the event loop.
 *
 * Acyclicity is the one invariant SQLite cannot express as a constraint, so this transaction is
 * the only place it is enforced; `onConflictDoNothing` against the unique
 * `(task_id, blocked_by_task_id)` index makes re-declaring an existing dependency a no-op,
 * because the Owner asked for a state of the world, not for a second row (AC-1).
 */
export async function addTaskDependencyEdge(
  ctx: RequestContext,
  input: AddTaskDependencyInput,
): Promise<Result<void, TaskDependencyCycleError>> {
  return ctx.db.transaction(
    (tx) => {
      const edges = tx
        .select({ taskId: taskDependency.taskId, blockedByTaskId: taskDependency.blockedByTaskId })
        .from(taskDependency)
        .where(eq(taskDependency.workspaceId, ctx.workspaceId))
        .all();

      const check = checkDependencyEdge(buildDependencyGraph(edges), input);
      if (!check.ok) return err(check.error);

      tx.insert(taskDependency)
        .values({
          workspaceId: ctx.workspaceId,
          taskId: input.taskId,
          blockedByTaskId: input.blockedByTaskId,
        })
        .onConflictDoNothing({
          target: [taskDependency.taskId, taskDependency.blockedByTaskId],
        })
        .run();
      return ok(undefined);
    },
    { behavior: "immediate" },
  );
}

export async function removeTaskDependencyEdge(
  ctx: RequestContext,
  input: AddTaskDependencyInput,
): Promise<Result<void, typeof CommonErrorCode.NotFound>> {
  const removed = await ctx.db
    .delete(taskDependency)
    .where(
      and(
        eq(taskDependency.workspaceId, ctx.workspaceId),
        eq(taskDependency.taskId, input.taskId),
        eq(taskDependency.blockedByTaskId, input.blockedByTaskId),
      ),
    )
    .returning({ id: taskDependency.id });
  if (removed.length === 0) return err(CommonErrorCode.NotFound);
  return ok(undefined);
}
