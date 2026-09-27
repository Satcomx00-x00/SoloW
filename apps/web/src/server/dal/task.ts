import "server-only";
import {
  type AddTaskDependencyInput,
  CommonErrorCode,
  type CreateSubtaskInput,
  type CreateTaskInput,
  type DeleteTaskInput,
  err,
  type ListTaskDependenciesInput,
  type ListTasksInput,
  ok,
  type Result,
  type SessionCursorDto,
  type SetTaskParentInput,
  type SetTaskRepositoriesInput,
  type TaskDeletionImpactDto,
  type TaskDependencyCycleError,
  type TaskDependencyListDto,
  type TaskDto,
  TaskErrorCode,
  type TaskListDto,
  type TaskParentCycleError,
  type TaskState,
} from "@solow/contracts";
import {
  buildDependencyGraph,
  CREDENTIAL_EXPIRED_REASON,
  checkDependencyEdge,
  checkParentEdge,
  resumeWorkflowCursor,
  taskCheckoutBranch,
  taskSubtree,
  validateWorkflowGraph,
  withinRetention,
} from "@solow/core";
import {
  harnessProfile,
  projectItem,
  session,
  task,
  taskDependency,
  taskRepository,
  workflow,
  workflowStep,
  worktree,
} from "@solow/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, notInArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { taskToDto } from "./mappers.js";
import { pageAfter, pageLimit, pageOrder, pageProbe, toPage } from "./page.js";

/** The transaction object drizzle hands a callback — same surface as `db`, and it exports no type. */
type Tx = Parameters<Parameters<RequestContext["db"]["transaction"]>[0]>[0];

/**
 * A Task and its live descendants, following the parent link down (issue #56).
 *
 * Live only: a sub-task already in History went there with a delete of its own, and keeps the
 * `deletedAt` that says when. One scan of `(id, parent_task_id)` and a walk in memory
 * (`taskSubtree`) rather than a recursive CTE, because the query has to run on both dialects
 * Decision 0008 names and this shape is the same on each.
 */
function liveSubtree(tx: Tx, ctx: RequestContext, rootId: string): string[] {
  const rows = tx
    .select({ id: task.id, parentTaskId: task.parentTaskId })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), liveTask()))
    .all() as Array<{ id: string; parentTaskId: string | null }>;
  return taskSubtree(new Map(rows.map((row) => [row.id, row.parentTaskId])), [rootId]);
}

/**
 * The Repository attachments of a set of Tasks, keyed by Task id (issue #7).
 *
 * One workspace-scoped query for the whole set rather than one per Task: the board reads a page
 * of cards, and a per-card query would turn one list into as many round trips as there are
 * Tasks. Ordered by position so every DTO's `repositories[0]` is the primary attachment, which
 * is what `primaryTaskRepository` decides from.
 */
export async function attachmentsForTasks(
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

/**
 * The Tasks that are still the Owner's to see: not deleted (spec F02 FR-10, history retention).
 *
 * A deleted Task keeps its row for the retention window so it can be restored and its record
 * read, and every reader of *live* Tasks — the board, the palette, the Issue's task list, the
 * counts a concurrency cap or an Issue's status are derived from — leaves it out through this
 * one predicate. The readers that want History ask for it by name (`includeDeleted`).
 */
export const liveTask = () => isNull(task.deletedAt);

export async function getTaskById(
  ctx: RequestContext,
  id: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<Result<TaskDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(task)
    .where(
      and(
        eq(task.workspaceId, ctx.workspaceId),
        eq(task.id, id),
        ...(opts.includeDeleted ? [] : [liveTask()]),
      ),
    )
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  const attachments = await attachmentsForTasks(ctx, [row.id]);
  return ok(taskToDto(row, attachments.get(row.id) ?? []));
}

export async function listTasks(
  ctx: RequestContext,
  input: ListTasksInput,
): Promise<Result<TaskListDto>> {
  const conditions = [eq(task.workspaceId, ctx.workspaceId), liveTask()];
  if (input.issueId) conditions.push(eq(task.issueId, input.issueId));
  if (input.state) conditions.push(eq(task.state, input.state));
  // `query` was accepted by the input schema and then dropped on the floor, so a filtered
  // request came back unfiltered and looked like it had worked. Matches `listIssues`.
  if (input.query) conditions.push(like(task.title, `%${input.query}%`));
  // `null` is a filter, not an absent one: it asks for the top-level Tasks (issue #56).
  // `undefined` — the field left out — is the unfiltered list, so `!== undefined` is the check.
  if (input.parentTaskId !== undefined) {
    conditions.push(
      input.parentTaskId === null
        ? isNull(task.parentTaskId)
        : eq(task.parentTaskId, input.parentTaskId),
    );
  }

  /*
   * A Task belongs to a Project through its Issue — there is no `task.project_id`, and there
   * should not be: a Task is work on an Issue, and which Project holds that Issue is the
   * Project's fact, not the Task's. So the filter reaches through `project_item`, and a Task
   * whose Issue is later adopted into a Project appears on that board with nothing to migrate.
   *
   * Subquery rather than a join, for the same reason as `listIssues`: an Issue in two Projects
   * would otherwise duplicate every Task under it.
   */
  if (input.projectId) {
    conditions.push(
      inArray(
        task.issueId,
        ctx.db
          .select({ id: projectItem.issueId })
          .from(projectItem)
          .where(
            and(
              eq(projectItem.workspaceId, ctx.workspaceId),
              eq(projectItem.projectId, input.projectId),
            ),
          ),
      ),
    );
  }
  if (input.unassigned) {
    conditions.push(
      notInArray(
        task.issueId,
        ctx.db
          .select({ id: projectItem.issueId })
          .from(projectItem)
          .where(eq(projectItem.workspaceId, ctx.workspaceId)),
      ),
    );
  }

  // One page, keyset — see `page.ts`. Every filter above is SQL, so the page the database
  // returns is the page the caller gets and the cursor needs no correcting.
  const after = pageAfter(input.cursor, task.createdAt, task.id);
  const rows = await ctx.db
    .select()
    .from(task)
    .where(and(...conditions, ...(after ? [after] : [])))
    .orderBy(...pageOrder(task.createdAt, task.id))
    .limit(pageProbe(pageLimit(input.limit)));
  const page = toPage(rows, pageLimit(input.limit), (row) => ({
    createdAt: row.createdAt,
    id: row.id,
  }));
  const attachments = await attachmentsForTasks(
    ctx,
    page.items.map((row) => row.id),
  );
  return ok({
    items: page.items.map((row) => taskToDto(row, attachments.get(row.id) ?? [])),
    nextCursor: page.nextCursor,
  });
}

/**
 * The attachment rows for one Task, from the input the Owner supplied (issue #7).
 *
 * `position` comes from array order — the Owner said which Repository matters most by listing it
 * first, and position 0 is what "the worktree the harness is started in" means. `checkoutBranch`
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
 * Create a sub-task from a parent, inheriting everything the Owner did not override (issue #56,
 * AC-1/AC-2).
 *
 * One `BEGIN IMMEDIATE` transaction for the reason `createTaskRecord` gives, with one addition:
 * the parent is *read inside it*. Reading the parent first and then writing a child from what it
 * said would let a concurrent `setRepositories` land in between, producing a sub-task that
 * inherited an attachment set its parent no longer has.
 *
 * The fork cursor is minted by the caller, outside this transaction, and that is deliberate: it
 * is a point in a log that only ever grows, so a cursor a few events behind the head is a
 * slightly earlier fork point, not a wrong one. Reading the parent's whole transcript under the
 * write lock to shave that off would hold it for as long as the transcript is long.
 */
export async function createSubtaskRecord(
  ctx: RequestContext,
  input: CreateSubtaskInput,
  fork: SessionCursorDto | null,
): Promise<
  Result<TaskDto, typeof CommonErrorCode.NotFound | typeof CommonErrorCode.ValidationFailed>
> {
  return ctx.db.transaction(
    (tx) => {
      const [parent] = tx
        .select()
        .from(task)
        .where(
          and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.parentTaskId), liveTask()),
        )
        .limit(1)
        .all();
      if (!parent) return err(CommonErrorCode.NotFound);

      const [row] = tx
        .insert(task)
        .values({
          workspaceId: ctx.workspaceId,
          // Never overridable: a sub-task under a different Issue from its parent is a new Task
          // with a misleading breadcrumb, not a split (see `createSubtaskInput`).
          issueId: parent.issueId,
          parentTaskId: parent.id,
          title: input.title,
          state: "backlog",
          agentProfileId: input.agentProfileId ?? parent.agentProfileId,
          executorProfileId: input.executorProfileId ?? parent.executorProfileId,
          forkSessionId: fork?.sessionId ?? null,
          forkSeq: fork?.seq ?? null,
          forkHash: fork?.hash ?? null,
          ...inheritedWorkflow(tx, ctx, parent),
        })
        .returning()
        .all();
      if (!row) return err(CommonErrorCode.ValidationFailed);

      const attachments = tx
        .insert(taskRepository)
        .values(
          attachmentValues(
            ctx,
            row.id,
            input.repositories ?? inheritedRepositories(tx, ctx, parent.id),
          ),
        )
        .returning()
        .all();
      return ok(taskToDto(row, attachments));
    },
    { behavior: "immediate" },
  );
}

/**
 * The parent's attachments as create input — its Repositories and base refs, and **not** its
 * checkout branches (AC-5).
 *
 * Dropping the branch is the isolation guarantee, not a detail: `attachmentValues` derives
 * `solow/task-<child id>` for every entry that omits one, so a sub-task provisions its own
 * worktrees. Copying the parent's branch names would put two Tasks in one working tree, which is
 * precisely the failure Principle II is written against — and it would do it silently, since
 * both Tasks would look correctly configured.
 */
function inheritedRepositories(
  tx: Tx,
  ctx: RequestContext,
  parentTaskId: string,
): CreateTaskInput["repositories"] {
  const rows = tx
    .select()
    .from(taskRepository)
    .where(
      and(eq(taskRepository.workspaceId, ctx.workspaceId), eq(taskRepository.taskId, parentTaskId)),
    )
    .orderBy(asc(taskRepository.position))
    .all() as (typeof taskRepository.$inferSelect)[];
  return rows.map((row) => ({
    repositoryId: row.repositoryId,
    ...(row.baseRef ? { baseRef: row.baseRef } : {}),
  })) as CreateTaskInput["repositories"];
}

/**
 * The Workflow columns a sub-task inherits: the parent's pipeline, at its **first** Step.
 *
 * Not the parent's cursor. A sub-task is a fresh run down the same pipeline — inheriting a
 * cursor parked on "review" would hand the child a Task that has, as far as the run loop is
 * concerned, already done the work it was split off to do.
 *
 * Inheritance is dropped rather than refused when the pipeline can no longer be entered — an
 * empty Workflow, or one whose graph has been edited into an invalid shape since the parent
 * attached. `attachTaskWorkflow` refuses in that situation because the Owner asked for that
 * specific Workflow and has to be told it is unusable; here the Owner asked to split a Task, and
 * failing that on the state of a pipeline they did not mention would be a refusal with nothing
 * actionable in it. The child is created on no Workflow, which the Task page shows plainly and
 * `workflow.attachTask` can still correct.
 */
function inheritedWorkflow(
  tx: Tx,
  ctx: RequestContext,
  parent: typeof task.$inferSelect,
): Pick<typeof task.$inferInsert, "workflowId" | "workflowStepId" | "workflowVersion"> {
  if (!parent.workflowId) return {};
  const steps = tx
    .select()
    .from(workflowStep)
    .where(
      and(
        eq(workflowStep.workspaceId, ctx.workspaceId),
        eq(workflowStep.workflowId, parent.workflowId),
      ),
    )
    .all() as (typeof workflowStep.$inferSelect)[];
  const first = resumeWorkflowCursor(steps, null);
  if (!first.ok || validateWorkflowGraph(steps).length > 0) return {};
  const [current] = tx
    .select({ version: workflow.version })
    .from(workflow)
    .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, parent.workflowId)))
    .limit(1)
    .all() as Array<{ version: number }>;
  return {
    workflowId: parent.workflowId,
    workflowStepId: first.data.id,
    // The version in force *now*, not the parent's: this attachment is being made today, and
    // recording the parent's older version would make a mid-run edit look like it happened to
    // the child when it happened before the child existed.
    workflowVersion: current?.version ?? parent.workflowVersion,
  };
}

/**
 * Re-parent a Task, or detach it, refusing a link that would close a chain (issue #56, AC-6).
 *
 * Same transaction shape as `addTaskDependencyEdge`, for the same two reasons stated there: the
 * read→decide→write window must not be interleaved with another handler (two concurrent calls
 * asking for `A under B` and `B under A` would both read an acyclic graph and both pass), and
 * `BEGIN IMMEDIATE` extends that to a second connection.
 *
 * Both Tasks must be live and in this Workspace. A parent in History would make its new child
 * vanish from under a breadcrumb that no longer resolves; a parent from another Workspace is
 * `NotFound` like every other cross-tenant id (Principle V). And the two must share an Issue, for
 * the reason `createSubtaskInput` refuses an `issueId`: a sub-task hanging off a Task on another
 * Issue is a misleading breadcrumb, not a split.
 */
export async function setTaskParent(
  ctx: RequestContext,
  input: SetTaskParentInput,
): Promise<
  Result<
    TaskDto,
    typeof CommonErrorCode.NotFound | typeof CommonErrorCode.ValidationFailed | TaskParentCycleError
  >
> {
  const written = ctx.db.transaction(
    (
      tx,
    ): Result<
      void,
      | typeof CommonErrorCode.NotFound
      | typeof CommonErrorCode.ValidationFailed
      | TaskParentCycleError
    > => {
      const rows = tx
        .select({ id: task.id, parentTaskId: task.parentTaskId, issueId: task.issueId })
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), liveTask()))
        .all() as Array<{ id: string; parentTaskId: string | null; issueId: string }>;
      const self = rows.find((row) => row.id === input.id);
      if (!self) return err(CommonErrorCode.NotFound);

      if (input.parentTaskId !== null) {
        const parent = rows.find((row) => row.id === input.parentTaskId);
        if (!parent) return err(CommonErrorCode.NotFound);
        if (parent.issueId !== self.issueId) return err(CommonErrorCode.ValidationFailed);
        const check = checkParentEdge(
          new Map(rows.map((row) => [row.id, row.parentTaskId])),
          input.id,
          input.parentTaskId,
        );
        if (!check.ok) return err(check.error);
      }

      tx.update(task)
        .set({ parentTaskId: input.parentTaskId, updatedAt: new Date().toISOString() })
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.id)))
        .run();
      return ok(undefined);
    },
    { behavior: "immediate" },
  );
  return written.ok ? getTaskById(ctx, input.id) : err(written.error);
}

/**
 * Replace a Task's whole attachment set (issue #7 AC-1).
 *
 * Refused once the Task has left `backlog`/`ready`: re-pointing a Task whose worktrees are
 * already live would orphan directories that nothing else knows how to find, and the running
 * harness would carry on working in a repository the Task no longer claims (Principle II).
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
      // Leaving `failed` clears the reason, unless the caller states one of its own.
      //
      // It used to persist: the column was only written when a caller passed it, so a Task
      // dragged out of Failed kept the old reason and carried it into `running` — a card that
      // reads "interrupted" while its harness is working, and a stale explanation attached to
      // whatever happens next. A reason describes the failure it belongs to, and that failure is
      // over.
      ...(extra?.failureReason !== undefined
        ? { failureReason: extra.failureReason }
        : state === "failed"
          ? {}
          : { failureReason: null }),
      // Reopening (done → ready) starts a new stretch of work: the last run's declaration would
      // otherwise sit on the card — and on the footer's gate — describing a run that is over.
      ...(state === "ready"
        ? { completedAt: null, completedOutcome: null, completedSummary: null }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, id)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);
  const attachments = await attachmentsForTasks(ctx, [row.id]);
  return ok(taskToDto(row, attachments.get(row.id) ?? []));
}

/** Count a profile's Tasks currently in `running` (for the concurrency cap). */
export async function countRunningForHarnessProfile(
  ctx: RequestContext,
  harnessProfileId: string,
): Promise<number> {
  const rows = await ctx.db
    .select({ id: task.id })
    .from(task)
    .where(
      and(
        eq(task.workspaceId, ctx.workspaceId),
        eq(task.agentProfileId, harnessProfileId),
        eq(task.state, "running"),
        liveTask(),
      ),
    );
  return rows.length;
}

/**
 * Task dependencies (issue #6). Every question about the *shape* of the graph is still answered
 * in `@solow/core`, so there is exactly one place cycle detection lives and it is one a
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
 * Delete one Task — into History, from where it can be restored for the retention window — the
 * board's card menu and the Task page both call this, so a Task no longer has to be deleted by
 * way of its Issue. The rows go for good when the orchestrator's retention sweep purges them.
 *
 * Two guards, and they are not the same kind of thing:
 *
 * - **An active Session** is refused (`StillRunning`) unless the caller has already told the
 *   orchestrator to stop this Task — `opts.stopIssued`. That flag is deliberately NOT part of
 *   `DeleteTaskInput`: it is something the server learns by doing (the stop returned), never
 *   something a client asserts, so no request can talk its way past the guard.
 *
 *   The guard keys on the Session, not on `task.state`. A Task reading `running` with no active
 *   Session is a row nothing will ever update again — its run died without reconciling — and
 *   that is precisely the wreckage an operator is trying to clear. Keying on the state instead
 *   made every such Task permanently undeletable from the UI, with no way out but SQL, and left
 *   it holding its Harness Profile's concurrency slot forever.
 *
 *   Why an accepted stop is enough even when the row still says `running`: cancellation is
 *   asynchronous (Inngest cancels between steps), so the state read here is stale by
 *   construction, and waiting for it to clear would wait forever whenever the run is already
 *   dead.
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
  opts: { stopIssued?: boolean } = {},
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

    // The delete takes the live sub-tasks with it (issue #56), so every check below asks about
    // the whole subtree rather than the Task named. Checking only the root would refuse a delete
    // that stops nothing and allow one that sends a running grandchild's harness to History.
    const subtree = liveSubtree(tx, ctx, input.id);

    const activeSessions = tx
      .select({ taskId: session.taskId })
      .from(session)
      .where(
        and(
          eq(session.workspaceId, ctx.workspaceId),
          inArray(session.taskId, subtree),
          eq(session.state, "active"),
        ),
      )
      .all() as Array<{ taskId: string }>;
    // `stopIssued` says the caller already stopped *this* Task's run — the router's
    // `activeSessionForTask(input.id)` path and nothing else. It cannot vouch for a descendant,
    // so a running sub-task still refuses the delete.
    if (activeSessions.some((row) => !(opts.stopIssued && row.taskId === input.id))) {
      return err(TaskErrorCode.StillRunning);
    }

    if (!input.force) {
      const dependents = (
        tx
          .select({ taskId: taskDependency.taskId })
          .from(taskDependency)
          .where(
            and(
              eq(taskDependency.workspaceId, ctx.workspaceId),
              inArray(taskDependency.blockedByTaskId, subtree),
            ),
          )
          .all() as Array<{ taskId: string }>
      )
        // An edge from inside the subtree is going too, so it gates nothing: refusing on it
        // would make a parent undeletable because its own sub-task declared it a blocker.
        .filter((row) => !subtree.includes(row.taskId));
      if (dependents.length > 0) return err(TaskErrorCode.HasDependents);
    }

    /*
     * A mark, not a cascade (spec F02 FR-10; history retention). The Task keeps its row, its
     * Sessions, events, reviews and worktree rows for the retention window, restorable from
     * History; the orchestrator's retention sweep runs `cascadeDeleteTasks` once the window has
     * passed. The `blocked_by` edges go now, both ways: a Task in History must not hold another
     * back, and a restored one gets no edges back — the Owner who forced past `HasDependents`
     * decided that.
     */
    //
    // The whole live subtree goes with one timestamp (issue #56). The shared `deletedAt` is what
    // `restoreTask` reads to bring back exactly the Tasks that left together — not a sub-task
    // the Owner had deleted on its own beforehand.
    const now = new Date().toISOString();
    tx.update(task)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(task.workspaceId, ctx.workspaceId), inArray(task.id, subtree)))
      .run();
    tx.delete(taskDependency)
      .where(
        and(
          eq(taskDependency.workspaceId, ctx.workspaceId),
          inArray(taskDependency.taskId, subtree),
        ),
      )
      .run();
    tx.delete(taskDependency)
      .where(
        and(
          eq(taskDependency.workspaceId, ctx.workspaceId),
          inArray(taskDependency.blockedByTaskId, subtree),
        ),
      )
      .run();
    return ok({ id: input.id });
  });
}

/**
 * Bring a deleted Task back from History (spec F02 FR-10).
 *
 * Only inside the retention window: past it the sweep may already have purged the rows, and a
 * restore that raced it would resurrect a Task with no Sessions. The state comes back exactly as
 * it was — a Task deleted while Running was stopped on the way out, and reconcile's reclaim is
 * what settles a `running` row with no run behind it, the same as after a restart.
 */
export async function restoreTask(
  ctx: RequestContext,
  id: string,
): Promise<
  Result<
    TaskDto,
    | typeof CommonErrorCode.NotFound
    | typeof TaskErrorCode.NotDeleted
    | typeof TaskErrorCode.RetentionExpired
  >
> {
  const [existing] = await ctx.db
    .select({ id: task.id, deletedAt: task.deletedAt, parentTaskId: task.parentTaskId })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, id)))
    .limit(1);
  if (!existing) return err(CommonErrorCode.NotFound);
  if (existing.deletedAt === null) return err(TaskErrorCode.NotDeleted);
  if (!withinRetention(existing.deletedAt)) return err(TaskErrorCode.RetentionExpired);
  const deletedAt = existing.deletedAt;

  ctx.db.transaction(
    (tx) => {
      /*
       * The sub-tasks that left with it come back with it (issue #56): the descendants carrying
       * the same `deletedAt`, which `deleteTask` stamps on the whole subtree at once. One the
       * Owner had deleted separately before keeps its own timestamp and stays in History.
       */
      const rows = tx
        .select({ id: task.id, parentTaskId: task.parentTaskId, deletedAt: task.deletedAt })
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.deletedAt, deletedAt)))
        .all() as Array<{ id: string; parentTaskId: string | null }>;
      const together = taskSubtree(new Map(rows.map((row) => [row.id, row.parentTaskId])), [id]);
      const now = new Date().toISOString();
      tx.update(task)
        .set({ deletedAt: null, updatedAt: now })
        .where(and(eq(task.workspaceId, ctx.workspaceId), inArray(task.id, together)))
        .run();

      /*
       * A sub-task restored while its parent stays in History is detached to the top level. The
       * alternative — a live Task whose breadcrumb points into History — would sit on the board
       * under nothing, and the retention sweep would detach it anyway the night the parent is
       * purged. Its fork point stays: where it started is still true.
       */
      if (existing.parentTaskId !== null) {
        const [parent] = tx
          .select({ deletedAt: task.deletedAt })
          .from(task)
          .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, existing.parentTaskId)))
          .limit(1)
          .all() as Array<{ deletedAt: string | null }>;
        if (!parent || parent.deletedAt !== null) {
          tx.update(task)
            .set({ parentTaskId: null })
            .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, id)))
            .run();
        }
      }
    },
    { behavior: "immediate" },
  );
  return getTaskById(ctx, id);
}

/**
 * The Tasks History lists: deleted inside the retention window, newest deletion first.
 * (Done Tasks reach History through `listTasks({ state: "done" })`; this is the other half.)
 */
export async function listDeletedTasks(ctx: RequestContext): Promise<Result<TaskDto[]>> {
  const rows = await ctx.db
    .select()
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), isNotNull(task.deletedAt)))
    .orderBy(desc(task.deletedAt));
  const live = rows.filter((row) => row.deletedAt !== null && withinRetention(row.deletedAt));
  const attachments = await attachmentsForTasks(
    ctx,
    live.map((row) => row.id),
  );
  return ok(live.map((row) => taskToDto(row, attachments.get(row.id) ?? [])));
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

  // The live subtree the delete would take with it, minus the Task itself (issue #56). Counted
  // rather than listed: the confirmation says how much work is about to go, and a dialog that
  // named every descendant would grow without bound on the one screen that must stay readable.
  const parents = await ctx.db
    .select({ id: task.id, parentTaskId: task.parentTaskId })
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), liveTask()));
  const descendants = taskSubtree(new Map(parents.map((row) => [row.id, row.parentTaskId])), [
    taskId,
  ]).filter((id) => id !== taskId);

  return ok({
    sessionCount: sessions.length,
    worktreeCount: worktrees.length,
    dependentCount: dependents.length,
    subtaskCount: descendants.length,
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

/**
 * Failed Tasks blocked on this Secret — the credential their Harness Profile spends (spec AC-013,
 * issue #63).
 *
 * Joined through `agent_profile` rather than trusted from `failureReason` alone: the reason
 * names a *class* of failure, not which credential caused it, and two Harness Profiles can hold
 * two different Secrets. A Task only belongs on this list when both are true — it failed on a
 * credential, and the credential that failed is the one an Owner just replaced. Called after a
 * Secret is (re)written, so its caller can resume every Task this unblocks without the Owner
 * finding and retrying each one by hand.
 */
export async function taskIdsBlockedByCredential(
  ctx: RequestContext,
  secretId: string,
): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: task.id })
    .from(task)
    .innerJoin(harnessProfile, eq(harnessProfile.id, task.agentProfileId))
    .where(
      and(
        eq(task.workspaceId, ctx.workspaceId),
        eq(task.state, "failed"),
        eq(task.failureReason, CREDENTIAL_EXPIRED_REASON),
        eq(harnessProfile.secretId, secretId),
        liveTask(),
      ),
    );
  return rows.map((row) => row.id);
}
