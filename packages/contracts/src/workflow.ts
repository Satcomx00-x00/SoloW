import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

/**
 * Workflows — an ordered pipeline of Steps, each run by its own Harness Profile (issue #5, spec
 * F03). A Task follows at most one Workflow and carries a durable cursor naming the Step it is
 * on, which is what lets "advance to the next Step" be a move of one Task rather than the
 * creation of a second one.
 */

/**
 * What has to happen before a Step lets a Task move on.
 *
 * `auto-unless-changes` is the interesting one and the reason this is not a boolean: a review
 * Step that found nothing to say should not cost a human a click, but the same Step having
 * asked for changes must. The distinction is a property of the *outcome*, not of the Step, so
 * the gate names the rule and `advanceWorkflowStep` applies it to what actually happened.
 *
 * None of these three values can bypass Principle I. A gate decides whether an intermediate
 * Step waits; whether the *Workflow* finishes is decided by a recorded human approval and
 * nothing else — see `advanceWorkflowStep`, where the last Step ignores this field entirely.
 *
 * An approval releases one gate, not the rest of the pipeline: the Task records which approval it
 * spent, so a `human` Step that follows another `human` Step needs its own. A `reject` or a
 * `request_changes` releases nothing at all — the `review` table holds refusals as well as
 * consents, and only one of the three is a decision to carry on.
 */
export const workflowStepGateSchema = z.enum(["human", "auto", "auto-unless-changes"]);
export type WorkflowStepGate = z.infer<typeof workflowStepGateSchema>;

/** Which signal counts as "this Step is finished" — the harness saying so, or a review landing. */
export const workflowAdvanceOnSchema = z.enum(["agent-signal", "review"]);
export type WorkflowAdvanceOn = z.infer<typeof workflowAdvanceOnSchema>;

/**
 * An automation attached to a Step, fired when a Task enters it (issue #63, subsumed by this
 * issue's third constraint: automations are a Step property, never a second rules engine).
 *
 * Deliberately minimal and deliberately present before anything fires it. The shape is the seam:
 * a `kind` the future dispatcher switches on and an opaque `config` it owns. Adding the column
 * later would be a migration on a populated table *and* an argument about whether automations
 * belong to Steps or to columns — the argument this issue already settled.
 */
export const workflowStepAutomationSchema = z.object({
  kind: z.string().min(1).max(64),
  config: z.record(z.unknown()).default({}),
});
export type WorkflowStepAutomation = z.infer<typeof workflowStepAutomationSchema>;

/**
 * What a branching Step asks about the outcome it just had (F03 FR-2's *Condition*, in the
 * shape this product's pipeline can actually answer).
 *
 * Two questions, and neither needs evidence the advance transaction does not already hold — a
 * condition that fetched its own facts would be a second rules engine, which is the thing the
 * Step model refuses to grow:
 *
 *  - `agent-decides`: **the harness answers the question.** The Step's brief carries it, asks for
 *    a `DECISION: yes` or `DECISION: no` line at the end of its final message, and the advance reads that
 *    line off the handoff — see `buildStepBrief` and `readHarnessDecision` in `@solow/core`. The
 *    harness is the party that has just read the code, the plan or the review, so it is the party
 *    that can say whether the condition is met; the operator only phrases the question. A harness
 *    that does not answer has not affirmed the condition, and that counts as `no`.
 *  - `produced-changes`: the Step left a diff behind. The same fact `auto-unless-changes` reads,
 *    corroborated the same way — the caller's claim is a floor, the Session log is the answer.
 */
export const workflowStepConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent-decides"), question: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("produced-changes") }),
]);
export type WorkflowStepCondition = z.infer<typeof workflowStepConditionSchema>;

/**
 * Where a Step sends the Task next, as a function of a condition — "if yes, run X; if no, run Y".
 *
 * On a Step rather than as a Step *kind*: a Condition node of its own would be a row with no
 * harness, no prompt and no gate, and every rule that reads a Step would have to learn to skip it.
 * The condition is evaluated on the outcome of the Step it hangs off, which is also the only
 * outcome it can be about.
 *
 * A null target means *the pipeline ends here*. It is the same end as running off the last Step
 * in rank order, and it goes through the same rule: `advanceWorkflowStep` completes nothing
 * without a recorded human approval, however a Task got to the end (Principle I). A target may
 * name an *earlier* Step — "changes requested, go back and implement" is the branch most worth
 * having — and the run loop's per-Step round budget is what bounds the loop that creates.
 */
export const workflowStepBranchSchema = z.object({
  when: workflowStepConditionSchema,
  thenStepId: idSchema.nullable(),
  elseStepId: idSchema.nullable(),
});
export type WorkflowStepBranch = z.infer<typeof workflowStepBranchSchema>;

/**
 * Workflow error codes.
 *
 * They live here rather than in `errors.ts` for the reason `TaskDependencyErrorCode` does:
 * `StaleOrder` is only meaningful next to the rank rules that produce it, and every code below
 * describes a state of a Step list rather than a state of the product.
 */
export const WorkflowErrorCode = {
  /** A Workflow with no Steps cannot be attached to a Task — there is nothing to run (AC-1). */
  Empty: "WORKFLOW_EMPTY",
  /** The named Step is not in the Workflow being asked about — a cross-Workflow id, or a deleted one. */
  StepNotInWorkflow: "WORKFLOW_STEP_NOT_IN_WORKFLOW",
  /**
   * The neighbours a reorder named are not in the order the caller believed. Someone else moved
   * a Step first; renaming the positions silently would apply the caller's intent to a list they
   * were not looking at.
   */
  StaleOrder: "WORKFLOW_STALE_ORDER",
  /** A Task's cursor is parked on this Step, so deleting it would strand that Task. */
  StepInUse: "WORKFLOW_STEP_IN_USE",
  /** At least one Task still follows this Workflow (the `SecretErrorCode.InUse` precedent). */
  InUse: "WORKFLOW_IN_USE",
  /** The Task has already left the backlog, so re-pointing its pipeline would change work in flight. */
  TaskAlreadyStarted: "WORKFLOW_TASK_ALREADY_STARTED",
  /** The Task follows no Workflow, so there is no cursor to read or advance. */
  TaskNotOnWorkflow: "WORKFLOW_TASK_NOT_ON_WORKFLOW",
  /**
   * The Task has already begun its pipeline — its cursor has moved, a handoff was carried, or an
   * approval was spent. Re-attaching would reset all three, discarding paid harness work with no
   * error and no warning, which is the outcome `resumeWorkflowCursor` refuses for the same reason.
   */
  TaskWorkflowInProgress: "WORKFLOW_TASK_IN_PROGRESS",
  /**
   * The Step the caller believed it was finishing is not the one the Task is on any more.
   *
   * This is `StaleOrder` for the cursor rather than for the list, and it exists because
   * `advanceTask` is called from a durable step that re-runs after a process death: a redelivered
   * call naming only the Task would advance the cursor a second time and skip a whole Step, with
   * nothing on the server able to tell that from an ordinary advance (Principle III, AC-5).
   */
  StaleCursor: "WORKFLOW_STALE_CURSOR",
  /**
   * A branch names the Step it hangs off as its own target. The cursor would not move, so the
   * `StaleCursor` replay guard — which relies on an advance moving it — would be silent, and a
   * retried step body would run the same Step again with nothing able to tell that from a loop
   * the operator asked for.
   */
  BranchTargetIsSelf: "WORKFLOW_BRANCH_TARGET_IS_SELF",
  /**
   * Another Step's branch still points at this one. Deleting it would turn "go to X" into a
   * dangling id — or, patched silently to null, into "the pipeline ends here", which is a change
   * of meaning nobody asked for. Re-point the branch first.
   */
  StepBranchedTo: "WORKFLOW_STEP_BRANCHED_TO",
  /**
   * The graph has a Step nothing leads to, or one from which the end can never be reached (F03
   * FR-5). Refused when a Task is *attached*, not when the Step is written: an operator building
   * a loop passes through both shapes on the way, and the designer flags them on the node as
   * they happen. A Task must not start down a pipeline that skips a Step or cannot finish.
   */
  GraphInvalid: "WORKFLOW_GRAPH_INVALID",
  /** A Step names an MCP server or a Skill that is not in this Workspace's libraries. */
  ToolNotInWorkspace: "WORKFLOW_TOOL_NOT_IN_WORKSPACE",
} as const;
export type WorkflowErrorCode = (typeof WorkflowErrorCode)[keyof typeof WorkflowErrorCode];

/**
 * `workspaceId` is absent from every input below — it is the tenant key and comes from the
 * session, so a Workflow can never be aimed at another Workspace by asking for one
 * (Principle V, see `common.ts`).
 */
export const createWorkflowInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});
export type CreateWorkflowInput = z.infer<typeof createWorkflowInput>;

export const renameWorkflowInput = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
});
export type RenameWorkflowInput = z.infer<typeof renameWorkflowInput>;

export const getWorkflowInput = z.object({ id: idSchema });
export type GetWorkflowInput = z.infer<typeof getWorkflowInput>;

export const deleteWorkflowInput = z.object({ id: idSchema });
export type DeleteWorkflowInput = z.infer<typeof deleteWorkflowInput>;

/**
 * `afterStepId` names the Step the new one follows; omitting it appends, and `null` puts it at
 * the head — before the first Step, which is the start of the pipeline. Positions are never sent:
 * a client that computed one would be describing a list it had already stopped looking at.
 */
export const addWorkflowStepInput = z.object({
  workflowId: idSchema,
  name: z.string().min(1).max(120),
  agentProfileId: idSchema,
  promptTemplate: z.string().max(20000).optional(),
  gate: workflowStepGateSchema.optional(),
  advanceOn: workflowAdvanceOnSchema.optional(),
  onEnter: workflowStepAutomationSchema.nullable().optional(),
  branch: workflowStepBranchSchema.nullable().optional(),
  /**
   * Library items loaded for this Step *on top of* the ones enabled Workspace-wide (spec F24).
   * Ids into `library.mcp` / `library.skill`; additive, never an exclusion.
   */
  mcpServerIds: z.array(idSchema).max(64).optional(),
  skillIds: z.array(idSchema).max(64).optional(),
  afterStepId: idSchema.nullable().optional(),
});
export type AddWorkflowStepInput = z.infer<typeof addWorkflowStepInput>;

export const updateWorkflowStepInput = z.object({
  stepId: idSchema,
  name: z.string().min(1).max(120).optional(),
  agentProfileId: idSchema.optional(),
  promptTemplate: z.string().max(20000).optional(),
  gate: workflowStepGateSchema.optional(),
  advanceOn: workflowAdvanceOnSchema.optional(),
  onEnter: workflowStepAutomationSchema.nullable().optional(),
  /** Null removes the branch; the Step then goes to its rank successor again. */
  branch: workflowStepBranchSchema.nullable().optional(),
  /** The whole list, replaced — the same rule as a Task's repositories. */
  mcpServerIds: z.array(idSchema).max(64).optional(),
  skillIds: z.array(idSchema).max(64).optional(),
});
export type UpdateWorkflowStepInput = z.infer<typeof updateWorkflowStepInput>;

/**
 * A move stated as the two Steps the moved one lands between, both nullable for the ends.
 *
 * This is the contract a drag surface calls, and it is deliberately not `{ stepId, position }`.
 * A position is an assertion about the whole list; a neighbour pair is an assertion about the
 * two rows the move actually touches, and it can be checked — if the pair is not adjacent any
 * more, the caller was looking at a stale list and the move is refused rather than guessed at.
 */
export const reorderWorkflowStepInput = z.object({
  stepId: idSchema,
  afterStepId: idSchema.nullable(),
  beforeStepId: idSchema.nullable(),
});
export type ReorderWorkflowStepInput = z.infer<typeof reorderWorkflowStepInput>;

export const deleteWorkflowStepInput = z.object({ stepId: idSchema });
export type DeleteWorkflowStepInput = z.infer<typeof deleteWorkflowStepInput>;

export const attachTaskWorkflowInput = z.object({ taskId: idSchema, workflowId: idSchema });
export type AttachTaskWorkflowInput = z.infer<typeof attachTaskWorkflowInput>;

export const detachTaskWorkflowInput = z.object({ taskId: idSchema });
export type DetachTaskWorkflowInput = z.infer<typeof detachTaskWorkflowInput>;

export const getTaskWorkflowInput = z.object({ taskId: idSchema });
export type GetTaskWorkflowInput = z.infer<typeof getTaskWorkflowInput>;

/**
 * Re-point a Task at the Workflow definition as it now stands, clearing `definitionDrifted`.
 *
 * Drift is raised by any Step edit and, without this, can never be lowered again — `attachTask`
 * refuses a Task past `ready`, so there is no other way back. A warning that is permanently on
 * for every in-flight Task is a warning an operator stops reading, which is worse than no warning.
 * Acknowledging is deliberately its own act rather than a side effect of advancing: it says a
 * person looked at what changed underneath the run and accepted it.
 */
export const acknowledgeTaskWorkflowDriftInput = z.object({ taskId: idSchema });
export type AcknowledgeTaskWorkflowDriftInput = z.infer<typeof acknowledgeTaskWorkflowDriftInput>;

/**
 * Report that the current Step finished. `handoff` is what the next Step is told; `producedChanges`
 * is what an `auto-unless-changes` gate reads.
 *
 * Whether a human has decided is *not* an input. It is read from the `review` table on the
 * server, because an input the caller controls is not a recorded decision, it is a claim
 * (Principle I, AC-4).
 *
 * `producedChanges` is a claim by the same reasoning, and is treated as one: the server ORs it
 * with what it has itself recorded about the Task, so reporting `false` on a Step that wrote a
 * diff cannot open the gate that exists to catch exactly that. It is kept as an input because the
 * harness knows first — it is a floor on the answer, never the whole of it.
 *
 * `fromStepId` names the Step the caller believes it is finishing, for the reason
 * `reorderWorkflowStepInput` names neighbours rather than a position: a payload that names only
 * the Task is not replay-safe, and this call is made from a durable step that re-runs.
 */
export const advanceTaskWorkflowInput = z.object({
  taskId: idSchema,
  fromStepId: idSchema,
  signal: workflowAdvanceOnSchema,
  producedChanges: z.boolean().default(false),
  handoff: z.string().max(20000).optional(),
  /**
   * Which durable step is making this call — an idempotency key, defaulted so an API caller
   * outside the run loop needs no opinion about it.
   *
   * Only the terminal Step reads it, and only to recognise a re-run of itself. Everywhere else
   * the cursor is the replay guard: an advance moves it, so a repeated call names a Step the Task
   * has left and is refused as stale. The last Step has nowhere to move the cursor to, so its own
   * step body can re-execute after committing and find the approval it needs already spent — by
   * itself. Passing the caller's durable step id is what lets it tell that apart from the *other*
   * call site asking for a second gate to open on one decision.
   */
  call: z.string().min(1).max(200).default("api"),
});
export type AdvanceTaskWorkflowInput = z.infer<typeof advanceTaskWorkflowInput>;

/**
 * `position` is derived on read from the row's rank, so callers order and index Steps without
 * ever handling a rank. `rank` still travels because a reorder has to name neighbours, and a
 * client that could not see the order it was reordering would be guessing.
 */
export const workflowStepDto = z
  .object({
    id: idSchema,
    workflowId: idSchema,
    name: z.string(),
    position: z.number().int().nonnegative(),
    rank: z.string(),
    agentProfileId: idSchema,
    promptTemplate: z.string(),
    gate: workflowStepGateSchema,
    advanceOn: workflowAdvanceOnSchema,
    onEnter: workflowStepAutomationSchema.nullable(),
    branch: workflowStepBranchSchema.nullable(),
    mcpServerIds: z.array(idSchema),
    skillIds: z.array(idSchema),
  })
  .merge(timestampsSchema);
export type WorkflowStepDto = z.infer<typeof workflowStepDto>;

export const workflowDto = z
  .object({
    id: idSchema,
    name: z.string(),
    description: z.string().nullable(),
    /**
     * Bumped by every Step write. A Task records the version in force when it was attached, so a
     * definition edited underneath a running Task is *detectable* rather than silently applied —
     * see `definitionDrifted`. Full copy-on-write versioning (F03) is a later change; this is the
     * half of it that costs nothing and cannot be added retroactively.
     */
    version: z.number().int().positive(),
    stepCount: z.number().int().nonnegative(),
  })
  .merge(timestampsSchema);
export type WorkflowDto = z.infer<typeof workflowDto>;

export const listWorkflowsInput = z.object({});
export type ListWorkflowsInput = z.infer<typeof listWorkflowsInput>;

export const workflowListDto = z.array(workflowDto);
export type WorkflowListDto = z.infer<typeof workflowListDto>;

export const workflowWithStepsDto = workflowDto.extend({ steps: z.array(workflowStepDto) });
export type WorkflowWithStepsDto = z.infer<typeof workflowWithStepsDto>;

/**
 * Where a Task is in its Workflow. `brief` is the prompt the current Step's harness should be
 * given — the Step's template with the previous Step's handoff prepended — so the runner reads
 * one field rather than re-deriving the concatenation and drifting from it (issue #82).
 */
export const taskWorkflowBindingDto = z.object({
  taskId: idSchema,
  workflowId: idSchema,
  workflowName: z.string(),
  /** The definition version this Task was attached at. */
  attachedVersion: z.number().int().positive(),
  currentVersion: z.number().int().positive(),
  definitionDrifted: z.boolean(),
  currentStep: workflowStepDto,
  steps: z.array(workflowStepDto),
  handoff: z.string().nullable(),
  brief: z.string(),
});
export type TaskWorkflowBindingDto = z.infer<typeof taskWorkflowBindingDto>;

/**
 * The outcome of reporting a Step finished.
 *
 * `awaiting-decision` and `held` are both "the cursor did not move", kept apart because they
 * need different things from the operator: one wants a human to decide, the other is still
 * waiting on the signal the Step actually advances on.
 */
export const workflowAdvanceStatusSchema = z.enum([
  "advanced",
  "awaiting-decision",
  "held",
  "completed",
]);
export type WorkflowAdvanceStatus = z.infer<typeof workflowAdvanceStatusSchema>;

/** The acknowledgement of a detach — the Task that no longer follows anything. */
export const workflowDetachDto = z.object({ taskId: idSchema });
export type WorkflowDetachDto = z.infer<typeof workflowDetachDto>;

export const workflowAdvanceDto = z.object({
  taskId: idSchema,
  status: workflowAdvanceStatusSchema,
  /** The Step the Task sits on after the call — unchanged unless the status is `advanced`. */
  currentStepId: idSchema,
  brief: z.string(),
});
export type WorkflowAdvanceDto = z.infer<typeof workflowAdvanceDto>;

/** What `workflow.authoringGuide` returns: the rules and the tool sequence, as markdown. */
export const workflowAuthoringGuideDto = z.object({ markdown: z.string() });
export type WorkflowAuthoringGuideDto = z.infer<typeof workflowAuthoringGuideDto>;
