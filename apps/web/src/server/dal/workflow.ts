import "server-only";
import {
  type AcknowledgeTaskWorkflowDriftInput,
  type AddWorkflowStepInput,
  type AdvanceTaskWorkflowInput,
  type AttachTaskWorkflowInput,
  CommonErrorCode,
  type CreateWorkflowInput,
  type DeleteWorkflowStepInput,
  err,
  ok,
  type RenameWorkflowInput,
  type ReorderWorkflowStepInput,
  type Result,
  type TaskWorkflowBindingDto,
  type UpdateWorkflowStepInput,
  type WorkflowAdvanceDto,
  type WorkflowDto,
  WorkflowErrorCode,
  type WorkflowListDto,
  type WorkflowStepDto,
  type WorkflowWithStepsDto,
} from "@gatecontrol/contracts";
import {
  advanceWorkflowStep,
  appendRank,
  buildStepBrief,
  rankBetween,
  rankForMove,
  resumeWorkflowCursor,
  sortSteps,
} from "@gatecontrol/core";
import {
  agentProfile,
  review,
  session,
  sessionEvent,
  task,
  workflow,
  workflowStep,
} from "@gatecontrol/db";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * Workflow persistence (issue #5, spec F03).
 *
 * Every statement is filtered on `ctx.workspaceId` (Principle V), and every id the caller sends
 * is resolved through a workspace-scoped read before it is written anywhere — a foreign key
 * proves the row exists *somewhere*, which is not the question tenancy asks.
 *
 * The ordering writes and the advance run inside `{ behavior: "immediate" }` transactions using
 * the driver's synchronous form, for the reason `addTaskDependencyEdge` spells out: reading the
 * neighbouring ranks and writing the new one must not have an await between them, or two
 * concurrent inserts both compute a midpoint against the same pair and one of them loses.
 */

type WorkflowRow = typeof workflow.$inferSelect;
type WorkflowStepRow = typeof workflowStep.$inferSelect;

type NotFound = typeof CommonErrorCode.NotFound;

/** Row → DTO, explicit fields only (the `mappers.ts` rule: never spread a row into a DTO). */
function workflowToDto(row: WorkflowRow, stepCount: number): WorkflowDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    stepCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * `position` is derived here and stored nowhere. Storing it would mean an insert in the middle
 * rewrote every row below it — the exact cost the rank exists to avoid.
 */
function stepToDto(row: WorkflowStepRow, position: number): WorkflowStepDto {
  return {
    id: row.id,
    workflowId: row.workflowId,
    name: row.name,
    position,
    rank: row.rank,
    agentProfileId: row.agentProfileId,
    promptTemplate: row.promptTemplate,
    gate: row.gate,
    advanceOn: row.advanceOn,
    onEnter: row.onEnter ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function stepsToDto(rows: readonly WorkflowStepRow[]): WorkflowStepDto[] {
  return sortSteps(rows).map((row, index) => stepToDto(row, index));
}

const now = () => new Date().toISOString();

export async function listWorkflows(ctx: RequestContext): Promise<Result<WorkflowListDto>> {
  const rows = await ctx.db
    .select()
    .from(workflow)
    .where(eq(workflow.workspaceId, ctx.workspaceId))
    .orderBy(asc(workflow.name));
  const steps = await ctx.db
    .select({ workflowId: workflowStep.workflowId })
    .from(workflowStep)
    .where(eq(workflowStep.workspaceId, ctx.workspaceId));

  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.workflowId, (counts.get(step.workflowId) ?? 0) + 1);
  return ok(rows.map((row) => workflowToDto(row, counts.get(row.id) ?? 0)));
}

export async function getWorkflowWithSteps(
  ctx: RequestContext,
  id: string,
): Promise<Result<WorkflowWithStepsDto, NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(workflow)
    .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const stepRows = await ctx.db
    .select()
    .from(workflowStep)
    .where(and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.workflowId, id)));
  const steps = stepsToDto(stepRows);
  return ok({ ...workflowToDto(row, steps.length), steps });
}

export async function createWorkflow(
  ctx: RequestContext,
  input: CreateWorkflowInput,
): Promise<Result<WorkflowDto>> {
  const [row] = await ctx.db
    .insert(workflow)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      description: input.description ?? null,
    })
    .returning();
  return row ? ok(workflowToDto(row, 0)) : err(CommonErrorCode.ValidationFailed);
}

export async function renameWorkflow(
  ctx: RequestContext,
  input: RenameWorkflowInput,
): Promise<Result<WorkflowDto, NotFound>> {
  const [row] = await ctx.db
    .update(workflow)
    .set({
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      updatedAt: now(),
    })
    .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, input.id)))
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);

  const steps = await ctx.db
    .select({ id: workflowStep.id })
    .from(workflowStep)
    .where(
      and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.workflowId, input.id)),
    );
  return ok(workflowToDto(row, steps.length));
}

/**
 * Deleting is refused while any Task still follows the Workflow — the `SecretErrorCode.InUse`
 * precedent. The alternative is a Task whose cursor points into nothing, which fails much later
 * as an unresumable run rather than here as a sentence the Owner can act on.
 */
export async function deleteWorkflow(
  ctx: RequestContext,
  id: string,
): Promise<Result<void, NotFound | typeof WorkflowErrorCode.InUse>> {
  return ctx.db.transaction(
    (tx) => {
      const [row] = tx
        .select({ id: workflow.id })
        .from(workflow)
        .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, id)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);

      const [follower] = tx
        .select({ id: task.id })
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.workflowId, id)))
        .limit(1)
        .all();
      if (follower) return err(WorkflowErrorCode.InUse);

      tx.delete(workflowStep)
        .where(and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.workflowId, id)))
        .run();
      tx.delete(workflow)
        .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, id)))
        .run();
      return ok(undefined);
    },
    { behavior: "immediate" },
  );
}

/**
 * What a Step write can refuse with: a missing or cross-tenant id, a stale order, or a row the
 * driver declined to insert. One alias rather than four signatures that drift apart.
 */
type StepWriteError = NotFound | typeof CommonErrorCode.ValidationFailed | WorkflowErrorCode;

/** The synchronous transaction handle the bun-sqlite driver hands the callback. */
type Tx = Parameters<Parameters<RequestContext["db"]["transaction"]>[0]>[0];

/**
 * Every Step write bumps the definition version, in SQL rather than by reading it first — the
 * four callers all sit inside a transaction that has already read the Step list, and a
 * read-modify-write of the counter would be one more thing to get wrong for no benefit.
 */
function incrementVersion(tx: Tx, ctx: RequestContext, workflowId: string): void {
  tx.update(workflow)
    .set({ version: sql`${workflow.version} + 1`, updatedAt: now() })
    .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, workflowId)))
    .run();
}

export async function addWorkflowStep(
  ctx: RequestContext,
  input: AddWorkflowStepInput,
): Promise<Result<WorkflowWithStepsDto, StepWriteError>> {
  const written = ctx.db.transaction(
    (tx): Result<string, StepWriteError> => {
      const [parent] = tx
        .select({ id: workflow.id, version: workflow.version })
        .from(workflow)
        .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, input.workflowId)))
        .limit(1)
        .all();
      if (!parent) return err(CommonErrorCode.NotFound);

      // The FK alone only proves the profile exists somewhere; without this a Step could name
      // another tenant's Agent Profile and inherit its credentials at run time (Principle V).
      const [profile] = tx
        .select({ id: agentProfile.id })
        .from(agentProfile)
        .where(
          and(
            eq(agentProfile.workspaceId, ctx.workspaceId),
            eq(agentProfile.id, input.agentProfileId),
          ),
        )
        .limit(1)
        .all();
      if (!profile) return err(CommonErrorCode.NotFound);

      const existing = sortSteps(
        tx
          .select()
          .from(workflowStep)
          .where(
            and(
              eq(workflowStep.workspaceId, ctx.workspaceId),
              eq(workflowStep.workflowId, input.workflowId),
            ),
          )
          .all(),
      );

      let rank: string;
      if (input.afterStepId) {
        const index = existing.findIndex((step) => step.id === input.afterStepId);
        if (index === -1) return err(WorkflowErrorCode.StepNotInWorkflow);
        const between = rankBetween(
          existing[index]?.rank ?? null,
          existing[index + 1]?.rank ?? null,
        );
        if (!between.ok) return err(between.error);
        rank = between.data;
      } else {
        rank = appendRank(existing.at(-1)?.rank ?? null);
      }

      const [row] = tx
        .insert(workflowStep)
        .values({
          workspaceId: ctx.workspaceId,
          workflowId: input.workflowId,
          rank,
          name: input.name,
          agentProfileId: input.agentProfileId,
          promptTemplate: input.promptTemplate ?? "",
          gate: input.gate ?? "human",
          advanceOn: input.advanceOn ?? "review",
          onEnter: input.onEnter ?? null,
        })
        .returning()
        .all();
      if (!row) return err(CommonErrorCode.ValidationFailed);

      incrementVersion(tx, ctx, input.workflowId);
      return ok(input.workflowId);
    },
    { behavior: "immediate" },
  );
  return written.ok ? getWorkflowWithSteps(ctx, written.data) : err(written.error);
}

export async function updateWorkflowStep(
  ctx: RequestContext,
  input: UpdateWorkflowStepInput,
): Promise<Result<WorkflowWithStepsDto, StepWriteError>> {
  const written = ctx.db.transaction(
    (tx): Result<string, StepWriteError> => {
      const [step] = tx
        .select()
        .from(workflowStep)
        .where(
          and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.id, input.stepId)),
        )
        .limit(1)
        .all();
      if (!step) return err(CommonErrorCode.NotFound);

      if (input.agentProfileId) {
        const [profile] = tx
          .select({ id: agentProfile.id })
          .from(agentProfile)
          .where(
            and(
              eq(agentProfile.workspaceId, ctx.workspaceId),
              eq(agentProfile.id, input.agentProfileId),
            ),
          )
          .limit(1)
          .all();
        if (!profile) return err(CommonErrorCode.NotFound);
      }

      // Only fields that would actually change something are written, and the version is bumped
      // only if at least one of them does. A bump is what raises `definitionDrifted` on every
      // attached Task, so a call that changed nothing — a form saved twice, a field set to the
      // value it already held — must not raise a warning about an edit that did not happen.
      const patch: Partial<typeof workflowStep.$inferInsert> = {};
      if (input.name !== undefined && input.name !== step.name) patch.name = input.name;
      if (input.agentProfileId !== undefined && input.agentProfileId !== step.agentProfileId) {
        patch.agentProfileId = input.agentProfileId;
      }
      if (input.promptTemplate !== undefined && input.promptTemplate !== step.promptTemplate) {
        patch.promptTemplate = input.promptTemplate;
      }
      if (input.gate !== undefined && input.gate !== step.gate) patch.gate = input.gate;
      if (input.advanceOn !== undefined && input.advanceOn !== step.advanceOn) {
        patch.advanceOn = input.advanceOn;
      }
      // The automation is a JSON blob, so equality is over its serialisation rather than its
      // identity — two structurally identical objects are the same automation.
      if (
        input.onEnter !== undefined &&
        JSON.stringify(input.onEnter ?? null) !== JSON.stringify(step.onEnter ?? null)
      ) {
        patch.onEnter = input.onEnter;
      }
      if (Object.keys(patch).length === 0) return ok(step.workflowId);

      tx.update(workflowStep)
        .set({ ...patch, updatedAt: now() })
        .where(
          and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.id, input.stepId)),
        )
        .run();

      incrementVersion(tx, ctx, step.workflowId);
      return ok(step.workflowId);
    },
    { behavior: "immediate" },
  );
  return written.ok ? getWorkflowWithSteps(ctx, written.data) : err(written.error);
}

/**
 * Move one Step between two named neighbours. Exactly one row is written: the moved Step's rank.
 * Nothing else in the list is read for anything but the adjacency check, and nothing else is
 * touched — which is what "an insert in the middle must not renumber every row" means in
 * practice, and what the router test asserts by comparing the neighbours' `updatedAt`.
 */
export async function reorderWorkflowStep(
  ctx: RequestContext,
  input: ReorderWorkflowStepInput,
): Promise<Result<WorkflowWithStepsDto, StepWriteError>> {
  const written = ctx.db.transaction(
    (tx): Result<string, StepWriteError> => {
      const [step] = tx
        .select()
        .from(workflowStep)
        .where(
          and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.id, input.stepId)),
        )
        .limit(1)
        .all();
      if (!step) return err(CommonErrorCode.NotFound);

      const siblings = tx
        .select()
        .from(workflowStep)
        .where(
          and(
            eq(workflowStep.workspaceId, ctx.workspaceId),
            eq(workflowStep.workflowId, step.workflowId),
          ),
        )
        .all();

      const rank = rankForMove(siblings, input);
      if (!rank.ok) return err(rank.error);

      tx.update(workflowStep)
        .set({ rank: rank.data, updatedAt: now() })
        .where(
          and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.id, input.stepId)),
        )
        .run();

      incrementVersion(tx, ctx, step.workflowId);
      return ok(step.workflowId);
    },
    { behavior: "immediate" },
  );
  return written.ok ? getWorkflowWithSteps(ctx, written.data) : err(written.error);
}

/**
 * Deleting a Step is refused while a Task's cursor sits on it. Removing it would leave that
 * Task with a cursor naming nothing, and `resumeWorkflowCursor` is deliberately an error in that
 * case rather than a silent restart — so the Task would be unrunnable, not merely misplaced.
 */
export async function deleteWorkflowStep(
  ctx: RequestContext,
  input: DeleteWorkflowStepInput,
): Promise<Result<WorkflowWithStepsDto, StepWriteError>> {
  const written = ctx.db.transaction(
    (tx): Result<string, StepWriteError> => {
      const [step] = tx
        .select()
        .from(workflowStep)
        .where(
          and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.id, input.stepId)),
        )
        .limit(1)
        .all();
      if (!step) return err(CommonErrorCode.NotFound);

      const [parked] = tx
        .select({ id: task.id })
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.workflowStepId, step.id)))
        .limit(1)
        .all();
      if (parked) return err(WorkflowErrorCode.StepInUse);

      tx.delete(workflowStep)
        .where(
          and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.id, input.stepId)),
        )
        .run();

      incrementVersion(tx, ctx, step.workflowId);
      return ok(step.workflowId);
    },
    { behavior: "immediate" },
  );
  return written.ok ? getWorkflowWithSteps(ctx, written.data) : err(written.error);
}

/**
 * Has this Task actually started down its current pipeline?
 *
 * `task.state` cannot answer it: advancing a cursor never writes a state, so a Task attached in
 * `backlog` and walked through two Steps is still in `backlog`. Without this, a second
 * `attachTask` is accepted and silently rewinds the cursor to Step one and drops the handoff —
 * two Steps of paid agent work discarded with no error, which is the outcome
 * `resumeWorkflowCursor` refuses to cause and this refuses to cause the other way round.
 *
 * "Begun" is any of the four things an advance leaves behind: a moved cursor, a carried handoff,
 * a reported one, or a spent approval.
 */
function taskHasBegunWorkflow(tx: Tx, ctx: RequestContext, row: typeof task.$inferSelect): boolean {
  if (row.workflowHandoff !== null) return true;
  if (row.workflowPendingHandoff !== null) return true;
  if (row.workflowDecisionId !== null) return true;
  if (!row.workflowId || !row.workflowStepId) return false;

  const steps = tx
    .select({ id: workflowStep.id, rank: workflowStep.rank })
    .from(workflowStep)
    .where(
      and(
        eq(workflowStep.workspaceId, ctx.workspaceId),
        eq(workflowStep.workflowId, row.workflowId),
      ),
    )
    .all();
  const first = resumeWorkflowCursor(steps, null);
  return first.ok && first.data.id !== row.workflowStepId;
}

/**
 * Put a Task on a Workflow, at its first Step.
 *
 * Refused once the Task has left `backlog`/`ready`: re-pointing the pipeline of a Task whose
 * agent is already running would change what that run is for, mid-run. Refused for an empty
 * Workflow, because a cursor has to name something for the resume rule to have an answer.
 */
export async function attachTaskWorkflow(
  ctx: RequestContext,
  input: AttachTaskWorkflowInput,
): Promise<Result<TaskWorkflowBindingDto, NotFound | WorkflowErrorCode>> {
  const written = ctx.db.transaction(
    (tx): Result<string, NotFound | WorkflowErrorCode> => {
      const [row] = tx
        .select()
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.taskId)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (row.state !== "backlog" && row.state !== "ready") {
        return err(WorkflowErrorCode.TaskAlreadyStarted);
      }
      if (row.workflowId && taskHasBegunWorkflow(tx, ctx, row)) {
        return err(WorkflowErrorCode.TaskWorkflowInProgress);
      }

      const [parent] = tx
        .select()
        .from(workflow)
        .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, input.workflowId)))
        .limit(1)
        .all();
      if (!parent) return err(CommonErrorCode.NotFound);

      const steps = tx
        .select()
        .from(workflowStep)
        .where(
          and(
            eq(workflowStep.workspaceId, ctx.workspaceId),
            eq(workflowStep.workflowId, input.workflowId),
          ),
        )
        .all();
      const first = resumeWorkflowCursor(steps, null);
      if (!first.ok) return err(first.error);

      tx.update(task)
        .set({
          workflowId: input.workflowId,
          workflowStepId: first.data.id,
          workflowVersion: parent.version,
          workflowHandoff: null,
          updatedAt: now(),
        })
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.taskId)))
        .run();
      return ok(input.taskId);
    },
    { behavior: "immediate" },
  );
  return written.ok ? getTaskWorkflowBinding(ctx, written.data) : err(written.error);
}

/**
 * Take a Task off its Workflow — guarded the same way attaching is, and for the same reasons.
 *
 * Both guards were missing, and their absence was not symmetric with `attachTaskWorkflow` by
 * accident so much as by omission. A detach of a Task that follows nothing reported success and
 * bumped `updated_at`, which is the failure `taskBinding` already refuses with
 * `TaskNotOnWorkflow`. A detach of a *running* Task threw its durable cursor and its carried
 * handoff away mid-pipeline — and, worse, defeated the `StepInUse`/`InUse` guards outright:
 * detach, then delete the Step the run was executing.
 */
export async function detachTaskWorkflow(
  ctx: RequestContext,
  taskId: string,
): Promise<Result<void, NotFound | WorkflowErrorCode>> {
  return ctx.db.transaction(
    (tx): Result<void, NotFound | WorkflowErrorCode> => {
      const [row] = tx
        .select()
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, taskId)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (!row.workflowId) return err(WorkflowErrorCode.TaskNotOnWorkflow);
      if (row.state !== "backlog" && row.state !== "ready") {
        return err(WorkflowErrorCode.TaskAlreadyStarted);
      }

      tx.update(task)
        .set({
          workflowId: null,
          workflowStepId: null,
          workflowVersion: null,
          workflowHandoff: null,
          workflowPendingHandoff: null,
          workflowDecisionId: null,
          updatedAt: now(),
        })
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, taskId)))
        .run();
      return ok(undefined);
    },
    { behavior: "immediate" },
  );
}

/**
 * Accept the Workflow definition as it now stands for one Task, clearing `definitionDrifted`.
 *
 * The cursor is deliberately untouched: this records that a person read what changed underneath
 * a run and chose to carry on, which is a different act from restarting the pipeline. Without it
 * drift is a one-way latch — any Step edit raises it on every attached Task and nothing lowers it
 * — and a warning that is permanently on is one an operator learns to scroll past.
 */
export async function acknowledgeTaskWorkflowDrift(
  ctx: RequestContext,
  input: AcknowledgeTaskWorkflowDriftInput,
): Promise<Result<TaskWorkflowBindingDto, NotFound | WorkflowErrorCode>> {
  const written = ctx.db.transaction(
    (tx): Result<string, NotFound | WorkflowErrorCode> => {
      const [row] = tx
        .select()
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.taskId)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (!row.workflowId) return err(WorkflowErrorCode.TaskNotOnWorkflow);

      const [parent] = tx
        .select({ version: workflow.version })
        .from(workflow)
        .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, row.workflowId)))
        .limit(1)
        .all();
      if (!parent) return err(CommonErrorCode.NotFound);

      tx.update(task)
        .set({ workflowVersion: parent.version, updatedAt: now() })
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.taskId)))
        .run();
      return ok(input.taskId);
    },
    { behavior: "immediate" },
  );
  return written.ok ? getTaskWorkflowBinding(ctx, written.data) : err(written.error);
}

export async function getTaskWorkflowBinding(
  ctx: RequestContext,
  taskId: string,
): Promise<Result<TaskWorkflowBindingDto, NotFound | WorkflowErrorCode>> {
  const [row] = await ctx.db
    .select()
    .from(task)
    .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, taskId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  if (!row.workflowId) return err(WorkflowErrorCode.TaskNotOnWorkflow);

  const [parent] = await ctx.db
    .select()
    .from(workflow)
    .where(and(eq(workflow.workspaceId, ctx.workspaceId), eq(workflow.id, row.workflowId)))
    .limit(1);
  if (!parent) return err(CommonErrorCode.NotFound);

  const stepRows = await ctx.db
    .select()
    .from(workflowStep)
    .where(
      and(
        eq(workflowStep.workspaceId, ctx.workspaceId),
        eq(workflowStep.workflowId, row.workflowId),
      ),
    );
  const resumed = resumeWorkflowCursor(stepRows, row.workflowStepId);
  if (!resumed.ok) return err(resumed.error);

  const steps = stepsToDto(stepRows);
  const current = steps.find((step) => step.id === resumed.data.id);
  if (!current) return err(WorkflowErrorCode.StepNotInWorkflow);

  return ok({
    taskId: row.id,
    workflowId: parent.id,
    workflowName: parent.name,
    attachedVersion: row.workflowVersion ?? parent.version,
    currentVersion: parent.version,
    definitionDrifted: (row.workflowVersion ?? parent.version) !== parent.version,
    currentStep: current,
    steps,
    handoff: row.workflowHandoff,
    brief: buildStepBrief(current, row.workflowHandoff),
  });
}

/**
 * The last decision recorded on this Task, if any (Principle I, AC-4).
 *
 * Read from the `review` table through the Task's Sessions, never from the caller's input — an
 * input a caller controls is a claim, not a decision. Both halves of the join are Workspace
 * scoped so a review row belonging to another tenant cannot satisfy this Task's gate.
 *
 * The *last* one rather than any one, and its decision rather than its bare existence, because
 * `review` records refusals as well as consents: `reject` and `request_changes` are a human
 * looking at the work and declining to integrate it, and a rule that counted them would let the
 * Workflow report itself finished on the strength of someone who explicitly stopped it. Taking
 * the newest also means an approval that has since been withdrawn stops opening gates.
 *
 * Ordered by insertion rather than by `created_at`: two decisions recorded inside the same
 * millisecond share a timestamp, and "which one is current" must never be a coin flip.
 *
 * It still asks about the Task rather than about the Step — per-Step review linkage needs the run
 * loop that produces one Session per Step (#26/#61). What stops one approval from releasing the
 * whole pipeline is not this query but `task.workflow_decision_id`, which records the one already
 * spent.
 */
function latestDecisionForTask(
  tx: Tx,
  ctx: RequestContext,
  taskId: string,
): { id: string; decision: string } | undefined {
  const [row] = tx
    .select({ id: review.id, decision: review.decision })
    .from(review)
    .innerJoin(session, eq(review.sessionId, session.id))
    .where(
      and(
        eq(review.workspaceId, ctx.workspaceId),
        eq(session.workspaceId, ctx.workspaceId),
        eq(session.taskId, taskId),
      ),
    )
    .orderBy(desc(sql`${review}.rowid`))
    .limit(1)
    .all();
  return row;
}

/**
 * Has the server itself seen this Task produce changes?
 *
 * `producedChanges` arrives as an input, and the gate it feeds — `auto-unless-changes` — exists
 * precisely to catch a Step that wrote something. A party reporting `false` about its own output
 * is deciding whether the rule applies to it, so the claim is a floor and this is the corroboration:
 * a `diff` event in the append-only Session log naming at least one file is the server's own
 * record, written by the orchestrator at the review gate from the worktree the web app may never
 * touch. It can only ever close a gate the claim would have opened, never the reverse.
 */
function taskHasRecordedChanges(tx: Tx, ctx: RequestContext, taskId: string): boolean {
  const rows = tx
    .select({ payload: sessionEvent.payload })
    .from(sessionEvent)
    .innerJoin(session, eq(sessionEvent.sessionId, session.id))
    .where(
      and(
        eq(sessionEvent.workspaceId, ctx.workspaceId),
        eq(session.workspaceId, ctx.workspaceId),
        eq(session.taskId, taskId),
        eq(sessionEvent.kind, "diff"),
      ),
    )
    .all();
  return rows.some((row) => {
    const files = (row.payload as { files?: unknown[] } | null)?.files;
    return Array.isArray(files) && files.length > 0;
  });
}

/**
 * Report that the Task's current Step finished, and move the cursor if the rules allow it (AC-2).
 *
 * The Task row is the same row throughout: advancing a Workflow never creates a second Task, it
 * moves one Task's cursor. Everything the decision reads — the cursor, the Step list, the latest
 * review, what the server has recorded about the change — is read inside the transaction that
 * writes the answer, so no input to a Principle I gate is evaluated against a snapshot the write
 * does not hold a lock on.
 *
 * `fromStepId` makes the call replay-safe (Principle III, AC-5). A redelivered payload naming only
 * the Task advances the cursor a second time and skips a Step, and a durable step that re-runs
 * after a process death is exactly the case this is called from — so the caller names the Step it
 * believes it is finishing and a mismatch is `StaleCursor` rather than a silent second advance.
 */
export async function advanceTaskWorkflow(
  ctx: RequestContext,
  input: AdvanceTaskWorkflowInput,
): Promise<Result<WorkflowAdvanceDto, NotFound | WorkflowErrorCode>> {
  return ctx.db.transaction(
    (tx): Result<WorkflowAdvanceDto, NotFound | WorkflowErrorCode> => {
      const [row] = tx
        .select()
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.taskId)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (!row.workflowId) return err(WorkflowErrorCode.TaskNotOnWorkflow);

      const steps = tx
        .select()
        .from(workflowStep)
        .where(
          and(
            eq(workflowStep.workspaceId, ctx.workspaceId),
            eq(workflowStep.workflowId, row.workflowId),
          ),
        )
        .all();
      const resumed = resumeWorkflowCursor(steps, row.workflowStepId);
      if (!resumed.ok) return err(resumed.error);
      if (input.fromStepId !== resumed.data.id) return err(WorkflowErrorCode.StaleCursor);

      const decision = latestDecisionForTask(tx, ctx, input.taskId);
      const unspentApproval =
        decision?.decision === "approve" && decision.id !== row.workflowDecisionId;
      // Only the `auto-unless-changes` gate reads this, so the corroborating scan is only paid
      // for when it can change the answer — and only when the claim is the one worth checking.
      const producedChanges =
        input.producedChanges ||
        (resumed.data.gate === "auto-unless-changes" &&
          taskHasRecordedChanges(tx, ctx, input.taskId));

      const advance = advanceWorkflowStep(steps, resumed.data.id, {
        signal: input.signal,
        producedChanges,
        unspentApproval,
      });
      if (!advance.ok) return err(advance.error);

      // The Step's own summary is held apart from the one it was given until the cursor actually
      // moves. A Step that reports in behind a closed gate is replayed later by a caller that no
      // longer has the agent's words, so throwing them away here loses the next Step's context on
      // the one path the state machine guarantees will be taken (AC-2).
      const reported = input.handoff ?? row.workflowPendingHandoff;
      const advanced = advance.data.status === "advanced";
      const handoff = advanced ? (reported ?? null) : row.workflowHandoff;
      const pendingHandoff = advanced ? null : (reported ?? null);
      const decisionId = advance.data.consumedApproval
        ? (decision?.id ?? null)
        : row.workflowDecisionId;

      if (
        advance.data.stepId !== row.workflowStepId ||
        handoff !== row.workflowHandoff ||
        pendingHandoff !== row.workflowPendingHandoff ||
        decisionId !== row.workflowDecisionId
      ) {
        tx.update(task)
          .set({
            workflowStepId: advance.data.stepId,
            workflowHandoff: handoff,
            workflowPendingHandoff: pendingHandoff,
            workflowDecisionId: decisionId,
            updatedAt: now(),
          })
          .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.id, input.taskId)))
          .run();
      }

      const landed = sortSteps(steps).find((step) => step.id === advance.data.stepId);
      if (!landed) return err(WorkflowErrorCode.StepNotInWorkflow);
      return ok({
        taskId: row.id,
        status: advance.data.status,
        currentStepId: landed.id,
        brief: buildStepBrief(landed, handoff),
      });
    },
    { behavior: "immediate" },
  );
}
