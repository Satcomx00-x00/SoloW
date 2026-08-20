import "server-only";
import {
  type AddTaskDependencyInput,
  CommonErrorCode,
  type CreateTaskInput,
  type DeleteTaskInput,
  err,
  type ListTaskDependenciesInput,
  type ListTasksInput,
  ok,
  type Result,
  type SetTaskRepositoriesInput,
  type TaskDeletionImpactDto,
  type TaskDependencyCycleError,
  type TaskDependencyListDto,
  type TaskDto,
  TaskErrorCode,
  type TaskListDto,
  type TaskState,
} from "@gatecontrol/contracts";
import { buildDependencyGraph, checkDependencyEdge, taskCheckoutBranch } from "@gatecontrol/core";
import { session, task, taskDependency, taskRepository, worktree } from "@gatecontrol/db";
import { and, asc, desc, eq, inArray, like } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { taskToDto } from "./mappers.js";
import { cascadeDeleteTasks } from "./task-cascade.js";

/**
 * The Repository attachments of a set of Tasks, keyed by Task id (issue #7).
 *
 * One workspace-scoped query for the whole set rather than one per Task: the board reads a page
 * of cards, and a per-card query would turn one list into as many round trips as there are
 * Tasks. Ordered by position so every DTO's `repositories[0]` is the primary attachment, which
 * is what `primaryTaskRepository` decides from.
 */
async function attachmentsForTasks(
  ctx: RequestContext,
  taskIds: readonly string[],
): Promise<Map<string, (typeof taskRepository.$inferSelect)[]>> {
  const byTask = new Map<string, (typeof taskRepository.$inferSelect)[]>();
  if (taskIds.length === 0) return byTask;

  const rows = await ctx.db
    .select()
    .from(taskRepository)
    .where(
      and(
        eq(taskRepository.workspaceId, ctx.workspaceId),
        inArray(taskRepository.taskId, [...taskIds]),
      ),
    )
    .orderBy(asc(taskRepository.position));
  for (const row of rows) {
    const existing = byTask.get(row.taskId);
    if (existing) existing.push(row);
    else byTask.set(row.taskId, [row]);
  }
  return byTask;
}

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
  const attachments = await attachmentsForTasks(ctx, [row.id]);
  return ok(taskToDto(row, attachments.get(row.id) ?? []));
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
  const attachments = await attachmentsForTasks(
    ctx,
    rows.map((row) => row.id),
  );
  return ok(rows.map((row) => taskToDto(row, attachments.get(row.id) ?? [])));
}

/**
 * The attachment rows for one Task, from the input the Owner supplied (issue #7).
 *
 * `position` comes from array order — the Owner said which Repository matters most by listing it
 * first, and position 0 is what "the worktree the agent is started in" means. `checkoutBranch`
 * falls back to the deterministic name `taskCheckoutBranch` derives, which is the same string
 * the orchestrator would have asked git for anyway; it is never left null, because a nullable
 * branch would make the `(task, repository, branch)` unique index enforce nothing.
 */
function attachmentValues(
  ctx: RequestContext,
  taskId: string,
  repositories: CreateTaskInput["repositories"],
): (typeof taskRepository.$inferInsert)[] {
  return repositories.map((entry, position) => ({
    workspaceId: ctx.workspaceId,
    taskId,
    repositoryId: entry.repositoryId,
    baseRef: entry.baseRef ?? null,
    checkoutBranch: entry.checkoutBranch ?? taskCheckoutBranch(taskId),
    position,
  }));
}

/**
 * Create a Task and its Repository attachments as one unit.
 *
 * One synchronous transaction (`behavior: "immediate"`, the shape `addTaskDependencyEdge`
 * already uses) rather than an insert followed by another: a Task with no attachment cannot be
 * launched at all, so a half-created one is not a degraded Task, it is an unrunnable row that
 * nothing would ever clean up. `BEGIN IMMEDIATE` takes the write lock on the first statement, so
 * the pair is atomic against a second connection as well as against the event loop.
 */
export async function createTaskRecord(
  ctx: RequestContext,
  input: CreateTaskInput & { state: TaskState },
): Promise<Result<TaskDto>> {
  return ctx.db.transaction(
    (tx) => {
      const [row] = tx
        .insert(task)
        .values({
          workspaceId: ctx.workspaceId,
          issueId: input.issueId,
          title: input.title,
          state: input.state,
          agentProfileId: input.agentProfileId,
          executorProfileId: input.executorProfileId,
        })
        .returning()
        .all();
      if (!row) return err(CommonErrorCode.ValidationFailed);

      const attachments = tx
        .insert(taskRepository)
        .values(attachmentValues(ctx, row.id, input.repositories))
        .returning()
        .all();
      return ok(taskToDto(row, attachments));
    },
    { behavior: "immediate" },
  );
}

/**
 * Replace a Task's whole attachment set (issue #7 AC-1).
 *
 * Refused once the Task has left `backlog`/`ready`: re-pointing a Task whose worktrees are
 * already live would orphan directories that nothing else knows how to find, and the running
 * agent would carry on working in a repository the Task no longer claims (Principle II).
 *
 * Delete-then-insert inside one transaction rather than a diff of the two sets. The Owner sent a
 * state of the world, and reconciling it row by row would have to decide what happens to a
 * `resultBranch` on an attachment that is being re-pointed — a question with no good answer,
 * which is exactly why the mutation is refused after `ready` instead.
 */
export async function setTaskRepositories(
  ctx: RequestContext,
  input: SetTaskRepositoriesInput,
): Promise<
  Result<TaskDto, typeof CommonErrorCode.NotFound | typeof TaskErrorCode.IllegalTransition>
> {
  return ctx.db.transaction(
    (tx) => {
      const [row] = tx
        .select()
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.taskId)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (row.state !== "backlog" && row.state !== "ready") {
        return err(TaskErrorCode.IllegalTransition);
      }

      tx.delete(taskRepository)
        .where(
          and(eq(taskRepository.workspaceId, ctx.workspaceId), eq(taskRepository.taskId, row.id)),
        )
        .run();
      const attachments = tx
        .insert(taskRepository)
        .values(attachmentValues(ctx, row.id, input.repositories))
        .returning()
        .all();
      return ok(taskToDto(row, attachments));
    },
    { behavior: "immediate" },
  );
}

/** Update a Task's state (callers gate the transition via services.canTransitionTask). */
export async function updateTaskState(
  ctx: RequestContext,
  id: string,
  state: TaskState,
  extra?: { failureReason?: string | null },
): Promise<Result<TaskDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(task)
    .set({
      state,
      ...(extra?.failureReason !== undefined ? { failureReason: extra.failureReason } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, id)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  const attachments = await attachmentsForTasks(ctx, [row.id]);
  return ok(taskToDto(row, attachments.get(row.id) ?? []));
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

/**
 * Delete one Task and everything hanging off it — the board's card menu and the Task page both
 * call this, so a Task no longer has to be deleted by way of its Issue.
 *
 * Two guards, and they are not the same kind of thing:
 *
 * - **Running** is refused outright (`StillRunning`). The router stops the agent first; this
 *   re-check inside the transaction is what makes that safe rather than merely likely, since a
 *   Task can re-enter `running` between the stop and the delete. No flag overrides it — an
 *   orphaned agent process is never what the Owner meant.
 * - **Dependents** are refused unless `force` (`HasDependents`). Other Tasks declaring a
 *   `blocked_by` edge on this one are gated on it deliberately; deleting it silently starts
 *   them. With `force` those edges go, and the dependents become runnable — which is a decision,
 *   so it is stated in the dialog rather than assumed.
 *
 * The Issue above is left alone even when this was its last Task: an Issue with no Tasks is a
 * perfectly ordinary state (it is how every Issue starts), unlike an orphaned Task.
 */
export async function deleteTask(
  ctx: RequestContext,
  input: DeleteTaskInput,
): Promise<
  Result<
    { id: string },
    | typeof CommonErrorCode.NotFound
    | typeof TaskErrorCode.StillRunning
    | typeof TaskErrorCode.HasDependents
  >
> {
  return ctx.db.transaction((tx) => {
    const [existing] = tx
      .select({ id: task.id, state: task.state })
      .from(task)
      .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.id)))
      .limit(1)
      .all();
    if (!existing) return err(CommonErrorCode.NotFound);

    const activeSession = tx
      .select({ id: session.id })
      .from(session)
      .where(
        and(
          eq(session.workspaceId, ctx.workspaceId),
          eq(session.taskId, input.id),
          eq(session.state, "active"),
        ),
      )
      .limit(1)
      .all();
    if (existing.state === "running" || activeSession.length > 0) {
      return err(TaskErrorCode.StillRunning);
    }

    if (!input.force) {
      const dependents = tx
        .select({ id: taskDependency.id })
        .from(taskDependency)
        .where(
          and(
            eq(taskDependency.workspaceId, ctx.workspaceId),
            eq(taskDependency.blockedByTaskId, input.id),
          ),
        )
        .limit(1)
        .all();
      if (dependents.length > 0) return err(TaskErrorCode.HasDependents);
    }

    cascadeDeleteTasks(tx, ctx.workspaceId, [input.id]);
    return ok({ id: input.id });
  });
}

/** What deleting this Task would destroy, for the confirmation to state. */
export async function taskDeletionImpact(
  ctx: RequestContext,
  taskId: string,
): Promise<Result<TaskDeletionImpactDto, typeof CommonErrorCode.NotFound>> {
  const [existing] = await ctx.db
    .select({ id: task.id, state: task.state })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, taskId)))
    .limit(1);
  if (!existing) return err(CommonErrorCode.NotFound);

  const sessions = await ctx.db
    .select({ id: session.id, state: session.state })
    .from(session)
    .where(and(eq(session.workspaceId, ctx.workspaceId), eq(session.taskId, taskId)));
  const worktrees = await ctx.db
    .select({ id: worktree.id })
    .from(worktree)
    .where(
      and(
        eq(worktree.workspaceId, ctx.workspaceId),
        eq(worktree.taskId, taskId),
        eq(worktree.status, "active"),
      ),
    );
  const dependents = await ctx.db
    .select({ id: taskDependency.id })
    .from(taskDependency)
    .where(
      and(
        eq(taskDependency.workspaceId, ctx.workspaceId),
        eq(taskDependency.blockedByTaskId, taskId),
      ),
    );

  return ok({
    sessionCount: sessions.length,
    worktreeCount: worktrees.length,
    dependentCount: dependents.length,
    running: existing.state === "running" || sessions.some((s) => s.state === "active"),
  });
}

/** The active Session to stop before deleting this Task, if there is one. */
export async function activeSessionForTask(
  ctx: RequestContext,
  taskId: string,
): Promise<string | undefined> {
  const [row] = await ctx.db
    .select({ id: session.id })
    .from(session)
    .where(
      and(
        eq(session.workspaceId, ctx.workspaceId),
        eq(session.taskId, taskId),
        eq(session.state, "active"),
      ),
    )
    .limit(1);
  return row?.id;
}
