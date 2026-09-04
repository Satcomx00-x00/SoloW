import {
  type AdvanceTaskWorkflowInput,
  CommonErrorCode,
  err,
  ok,
  type Result,
  type TaskWorkflowBindingDto,
  type WorkflowAdvanceDto,
  WorkflowErrorCode,
  type WorkflowStepDto,
} from "@solow/contracts";
import { advanceWorkflowStep, buildStepBrief, resumeWorkflowCursor, sortSteps } from "@solow/core";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { review, session, sessionEvent, task, workflow, workflowStep } from "./schema.js";

/**
 * The Workflow *run* — reading where a Task has got to, and moving it on (issue #5, spec F03).
 *
 * This lives in `@solow/db` rather than in the web app's DAL because both apps run it: the web
 * app advances a Task when a person decides, and the orchestrator advances the same Task from
 * inside a durable step when an agent reports in (AC-2, AC-3, AC-5). `@solow/db` is the one
 * package both already depend on, and the orchestrator cannot import from `apps/web` at all.
 *
 * Duplicating the transaction on the orchestrator's side was the alternative, and it is the worst
 * outcome available here: `unspentApproval` and `producedChanges` are the two inputs to a
 * Principle I gate, and two copies of them are two copies that drift. The web DAL keeps the
 * `RequestContext` signatures its router and its tests already use and delegates here — the
 * session-to-`workspaceId` unwrap stays at the boundary where Principle V is enforced.
 *
 * Deliberately no `import "server-only"`: that is the one line of the file it moved out of that
 * would break the orchestrator at import time.
 *
 * Every statement is filtered on the caller's `workspaceId` (Principle V), and the advance runs
 * inside a `{ behavior: "immediate" }` transaction using the driver's synchronous form, so that
 * reading the cursor and writing the cursor have no await between them.
 */

type WorkflowStepRow = typeof workflowStep.$inferSelect;

type NotFound = typeof CommonErrorCode.NotFound;

/** The synchronous transaction handle the bun-sqlite driver hands the callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const now = () => new Date().toISOString();

/**
 * `position` is derived here and stored nowhere. Storing it would mean an insert in the middle
 * rewrote every row below it — the exact cost the rank exists to avoid.
 */
export function stepToDto(row: WorkflowStepRow, position: number): WorkflowStepDto {
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

export function stepsToDto(rows: readonly WorkflowStepRow[]): WorkflowStepDto[] {
  return sortSteps(rows).map((row, index) => stepToDto(row, index));
}

/**
 * Which Step is this Task on, and what is the brief for it (AC-5).
 *
 * READ-ONLY, and that matters: the resolved cursor is *not* written back. `taskHasBegunWorkflow`
 * in the web DAL reads exactly these columns to refuse a re-attach, so persisting a merely
 * resolved cursor would make "this Task has begun its pipeline" true for a Task whose agent has
 * never started.
 */
export async function loadTaskWorkflowRun(
  db: Db,
  workspaceId: string,
  taskId: string,
): Promise<Result<TaskWorkflowBindingDto, NotFound | WorkflowErrorCode>> {
  const [row] = await db
    .select()
    .from(task)
    .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  if (!row.workflowId) return err(WorkflowErrorCode.TaskNotOnWorkflow);

  const [parent] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.workspaceId, workspaceId), eq(workflow.id, row.workflowId)))
    .limit(1);
  if (!parent) return err(CommonErrorCode.NotFound);

  const stepRows = await db
    .select()
    .from(workflowStep)
    .where(
      and(eq(workflowStep.workspaceId, workspaceId), eq(workflowStep.workflowId, row.workflowId)),
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
  workspaceId: string,
  taskId: string,
): { id: string; decision: string } | undefined {
  const [row] = tx
    .select({ id: review.id, decision: review.decision })
    .from(review)
    .innerJoin(session, eq(review.sessionId, session.id))
    .where(
      and(
        eq(review.workspaceId, workspaceId),
        eq(session.workspaceId, workspaceId),
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
function taskHasRecordedChanges(tx: Tx, workspaceId: string, taskId: string): boolean {
  const rows = tx
    .select({ payload: sessionEvent.payload })
    .from(sessionEvent)
    .innerJoin(session, eq(sessionEvent.sessionId, session.id))
    .where(
      and(
        eq(sessionEvent.workspaceId, workspaceId),
        eq(session.workspaceId, workspaceId),
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
  db: Db,
  workspaceId: string,
  // `call` is optional here and required in the contract: the tRPC route arrives with the schema
  // default already applied, while a direct caller inside the orchestrator names its own durable
  // step. Normalised once, below, so the comparison never comes down to `undefined === undefined`.
  input: Omit<AdvanceTaskWorkflowInput, "call"> & { call?: string },
): Promise<Result<WorkflowAdvanceDto, NotFound | WorkflowErrorCode>> {
  const call = input.call ?? "api";
  return db.transaction(
    (tx): Result<WorkflowAdvanceDto, NotFound | WorkflowErrorCode> => {
      const [row] = tx
        .select()
        .from(task)
        .where(and(eq(task.workspaceId, workspaceId), eq(task.id, input.taskId)))
        .limit(1)
        .all();
      if (!row) return err(CommonErrorCode.NotFound);
      if (!row.workflowId) return err(WorkflowErrorCode.TaskNotOnWorkflow);

      const steps = tx
        .select()
        .from(workflowStep)
        .where(
          and(
            eq(workflowStep.workspaceId, workspaceId),
            eq(workflowStep.workflowId, row.workflowId),
          ),
        )
        .all();
      const resumed = resumeWorkflowCursor(steps, row.workflowStepId);
      if (!resumed.ok) return err(resumed.error);
      if (input.fromStepId !== resumed.data.id) return err(WorkflowErrorCode.StaleCursor);

      const decision = latestDecisionForTask(tx, workspaceId, input.taskId);
      const unspentApproval =
        decision?.decision === "approve" && decision.id !== row.workflowDecisionId;
      // The same approval, already recorded as spent by this Task — a replay of a call that
      // committed, not a Task asking a second gate to open on one decision. Only the terminal
      // Step reads it, because only there does the cursor stay put and let a re-executed step
      // body past the `StaleCursor` guard above.
      /*
       * ...and spent by *this same call, on this same Step* — which together are what make this a
       * replay rather than a second gate crossing. Both halves were established by watching a
       * narrower rule fail:
       *
       * - Step alone is not enough. Both advance call sites in the run lifecycle sit on the
       *   terminal Step and pass the same signal when `advance_on` is `agent-signal`, so a
       *   Step-scoped rule let the review call finish a Workflow on the approval the agent-signal
       *   call had already spent.
       * - Call alone is not enough either. A caller that names no call — the tRPC route, which
       *   takes the schema default — would then match its own earlier spend at a *different*
       *   Step, so one approval that advanced the plan also completed the pipeline.
       *
       * Either of those is the same bypass Principle I refuses: one decision releasing every gate
       * that is left.
       */
      const spentHere = `${resumed.data.id}|${call}`;
      const approvalAlreadySpent =
        decision?.decision === "approve" &&
        decision.id === row.workflowDecisionId &&
        row.workflowDecisionCall === spentHere;
      // Only the `auto-unless-changes` gate reads this, so the corroborating scan is only paid
      // for when it can change the answer — and only when the claim is the one worth checking.
      const producedChanges =
        input.producedChanges ||
        (resumed.data.gate === "auto-unless-changes" &&
          taskHasRecordedChanges(tx, workspaceId, input.taskId));

      const advance = advanceWorkflowStep(steps, resumed.data.id, {
        signal: input.signal,
        producedChanges,
        unspentApproval,
        approvalAlreadySpent,
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
      // Which call spent it, so a re-run of that same call can recognise its own work.
      const decisionCall = advance.data.consumedApproval ? spentHere : row.workflowDecisionCall;

      if (
        advance.data.stepId !== row.workflowStepId ||
        handoff !== row.workflowHandoff ||
        pendingHandoff !== row.workflowPendingHandoff ||
        decisionId !== row.workflowDecisionId ||
        decisionCall !== row.workflowDecisionCall
      ) {
        tx.update(task)
          .set({
            workflowStepId: advance.data.stepId,
            workflowHandoff: handoff,
            workflowPendingHandoff: pendingHandoff,
            workflowDecisionId: decisionId,
            workflowDecisionCall: decisionCall,
            updatedAt: now(),
          })
          .where(and(eq(task.workspaceId, workspaceId), eq(task.id, input.taskId)))
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

/**
 * Throw away what the current Step reported, without moving anything else.
 *
 * Called by the orchestrator after a *rejection*. A rejection is not a Step completion, so the
 * cursor deliberately does not move — but the rejected attempt still wrote its summary into
 * `workflow_pending_handoff`, and that column is promoted into `workflow_handoff` by whatever
 * eventually completes the Step. Left in place, the work a human explicitly refused becomes the
 * inbound context of the next Step, presented to that agent as what it is building on.
 *
 * Guarded on `workflow_step_id = fromStepId` for the same reason `advanceTaskWorkflow` refuses a
 * `StaleCursor`: the caller is a durable step that can re-run after the cursor has already moved
 * on, and a clear that ignored the cursor would then wipe the *next* Step's inbound summary.
 */
export async function clearTaskWorkflowPendingHandoff(
  db: Db,
  workspaceId: string,
  taskId: string,
  fromStepId: string,
): Promise<void> {
  await db
    .update(task)
    .set({ workflowPendingHandoff: null, updatedAt: now() })
    .where(
      and(
        eq(task.workspaceId, workspaceId),
        eq(task.id, taskId),
        eq(task.workflowStepId, fromStepId),
      ),
    );
}
