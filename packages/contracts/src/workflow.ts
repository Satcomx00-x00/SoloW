import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";
import { harnessPermissionModeSchema } from "./profile.js";
import { taskCompletionOutcomeSchema } from "./widget.js";

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
 *  - `outcome`: **how the harness said its run ended** — the `task_complete` declaration's
 *    `outcome`, which the run loop already hands the advance for the gate. `blocked` is the one
 *    this exists for: a harness that stopped because it could not go on used to reach the review
 *    gate looking exactly like one that finished, and the only way to route it to a person or an
 *    escalation Step was to ask a second question in prose. A harness that declared nothing has
 *    no outcome, and matches none.
 */
export const workflowStepConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent-decides"), question: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("produced-changes") }),
  z.object({ kind: z.literal("outcome"), is: taskCompletionOutcomeSchema }),
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
 * How much the harness of one Step may do without asking — the Step's own answer, or null for
 * "whatever its Harness Profile says" (spec F05's `permissionMode`, on a Step).
 *
 * It belongs here as well as on the Profile because **a Step is a harness launch**: a Task under
 * a Workflow starts a fresh session at every Step, with that Step's Profile, that Step's MCP
 * servers and Skills, and that Step's brief. The permission posture is a launch parameter exactly
 * like those, and wanting a *plan* Step and a *build* Step on the same Profile is the ordinary
 * case, not an exotic one — before this it took two Profiles differing in one enum, each with its
 * own credential binding and concurrency cap.
 *
 * Null rather than a default so that adding the column changed no pipeline's behaviour, and so
 * that a Step which has no opinion keeps following its Profile when the Profile is re-postured.
 * The Profile keeps the field, and keeps deciding, for the run that has no Step at all — a Task
 * on no Workflow — which is why moving it here could not mean removing it there.
 */
export const workflowStepPermissionModeSchema = harnessPermissionModeSchema.nullable();

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
  /**
   * An imported document's Steps have nowhere to run: this Workspace has no Harness Profile at
   * all, so there is not even a fallback to point them at. Refused whole rather than written as
   * a pipeline of Steps with a null harness, which the schema does not allow and the runner
   * could not start.
   */
  NoHarnessProfile: "WORKFLOW_NO_HARNESS_PROFILE",
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
  /** Null, or absent, leaves the posture to the Step's Harness Profile. */
  permissionMode: workflowStepPermissionModeSchema.optional(),
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
  /** Null hands the posture back to the Harness Profile; a value overrides it for this Step. */
  permissionMode: workflowStepPermissionModeSchema.optional(),
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
   * How the harness said the Step ended, for an `outcome` branch to read. Absent when it said
   * nothing — which no outcome condition matches, by the same rule that reads a missing
   * `DECISION` line as `no`. A report, like `handoff`: it moves the cursor only where the Step's
   * own rules let a report do that, and it never stands in for a decision.
   */
  outcome: taskCompletionOutcomeSchema.optional(),
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
    permissionMode: workflowStepPermissionModeSchema,
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

/**
 * Which way out of the Step the advance took, or would have. `next` is the rank successor of an
 * unbranched Step; `then`/`else` are a branch's two; null when the Step was held on a signal it
 * does not advance on, so no exit was chosen at all.
 */
export const workflowStepExitKindSchema = z.enum(["next", "then", "else"]);
export type WorkflowStepExitKind = z.infer<typeof workflowStepExitKindSchema>;

/**
 * *Why* an advance answered the way it did — the facts the rule read, stated once by the rule
 * that read them (F03, "decisions when changing Step").
 *
 * The advance used to return a status and a cursor and nothing else, so a Task that sat at
 * `awaiting-decision` could not say which gate held it, and a branch that went back to
 * "Implement" left no record of the answer that sent it there. This is that record. It is what
 * the run loop writes into the Session log as a `workflow_decision`, and it is derived from the
 * same evaluation that moved the cursor — never re-evaluated by whoever displays it.
 */
export const workflowAdvanceExplanationSchema = z.object({
  gate: workflowStepGateSchema,
  /** Did this Step's gate ask for a person, given what happened on it? */
  needsApproval: z.boolean(),
  /** The Step's branch condition and how it evaluated, or null for an unbranched Step. */
  condition: z.object({ when: workflowStepConditionSchema, holds: z.boolean() }).nullable(),
  exit: workflowStepExitKindSchema.nullable(),
  /**
   * Whether the Step produced changes, *as the rules read it*: the harness's claim, corroborated
   * by the server's own `diff` record when a gate or a branch depends on it. Reported so the
   * decision record can carry the fact the rule used rather than the claim it was handed.
   */
  producedChanges: z.boolean(),
});
export type WorkflowAdvanceExplanation = z.infer<typeof workflowAdvanceExplanationSchema>;

export const workflowAdvanceDto = z.object({
  taskId: idSchema,
  status: workflowAdvanceStatusSchema,
  /** The Step the Task sits on after the call — unchanged unless the status is `advanced`. */
  currentStepId: idSchema,
  brief: z.string(),
  explanation: workflowAdvanceExplanationSchema,
});
export type WorkflowAdvanceDto = z.infer<typeof workflowAdvanceDto>;

/** What `workflow.authoringGuide` returns: the rules and the tool sequence, as markdown. */
export const workflowAuthoringGuideDto = z.object({ markdown: z.string() });
export type WorkflowAuthoringGuideDto = z.infer<typeof workflowAuthoringGuideDto>;

/**
 * A Workflow as a portable document — what `workflow.export` writes and `workflow.import` reads,
 * so a pipeline can be shared between Workspaces, between instances, or checked into a repo.
 *
 * Every id is gone. A Workflow's ids are meaningless outside the Workspace that minted them: the
 * Harness Profile a Step runs on, the MCP servers and Skills it loads, and the Steps a branch
 * targets are all rows of a database the reader does not have. So the document names what it can
 * name portably — **profiles, servers and Skills by name; branch targets by their index in
 * `steps`** — and the import resolves those against the Workspace it lands in.
 *
 * That resolution is lossy by construction, and the format is honest about which way it fails:
 * an unmatched *tool* is dropped and reported, because a Skill is additive and a pipeline without
 * it still runs; an unmatched *harness profile* falls back to one that exists and is reported,
 * because a Step with no harness is not a Step. Neither silently succeeds — see `workflowImportDto`.
 *
 * Deliberately absent: `version`, `createdAt`, timestamps, and any note of where the export came
 * from. This is a *definition*, not a snapshot of a row — the version counter belongs to the
 * Workflow the import creates, which has been edited zero times.
 */
export const WORKFLOW_DOCUMENT_FORMAT = "solow.workflow";
export const WORKFLOW_DOCUMENT_VERSION = 1;

/**
 * A branch in a document. `thenStep`/`elseStep` are indices into the document's own `steps`
 * array — null still means *the pipeline ends here*, exactly as `thenStepId` does on the row.
 *
 * An index rather than a name: Step names are not unique within a Workflow, and a document whose
 * branch resolved to whichever "Review" came first would reorder a pipeline on import without
 * saying so.
 */
export const workflowDocumentBranchSchema = z.object({
  when: workflowStepConditionSchema,
  thenStep: z.number().int().nonnegative().nullable(),
  elseStep: z.number().int().nonnegative().nullable(),
});
export type WorkflowDocumentBranch = z.infer<typeof workflowDocumentBranchSchema>;

/**
 * One Step of a document. Field names follow `addWorkflowStepInput` wherever the field survives
 * the trip unchanged, so the document reads like the API that will replay it; only the three
 * that cannot travel as ids are renamed to say they are names.
 */
export const workflowDocumentStepSchema = z.object({
  name: z.string().min(1).max(120),
  /** The Harness Profile this Step runs on, by name. */
  harnessProfile: z.string().min(1).max(120),
  promptTemplate: z.string().max(20000).default(""),
  gate: workflowStepGateSchema.default("human"),
  advanceOn: workflowAdvanceOnSchema.default("review"),
  onEnter: workflowStepAutomationSchema.nullable().default(null),
  branch: workflowDocumentBranchSchema.nullable().default(null),
  /** Library items loaded on top of the Workspace-wide ones, by name (spec F24). */
  mcpServers: z.array(z.string().min(1).max(200)).max(64).default([]),
  skills: z.array(z.string().min(1).max(200)).max(64).default([]),
  /**
   * Travels as itself: unlike a profile or a Skill, a permission mode is not a name that has to
   * resolve against anything in the importing Workspace — it is one of three fixed postures, and
   * it means the same thing everywhere. Null is "whatever the profile says", which is also what
   * it means on the way out.
   */
  permissionMode: workflowStepPermissionModeSchema.default(null),
});
export type WorkflowDocumentStep = z.infer<typeof workflowDocumentStepSchema>;

/**
 * `format` and `version` are literals rather than free strings so that pointing the import at the
 * wrong JSON — a `package.json`, another product's pipeline — fails at the boundary with a shape
 * error, instead of importing a Workflow named `undefined` with no Steps.
 *
 * A branch index that names no Step is refused here too. It is the one cross-field rule the
 * document has, and checking it at the edge means neither the DAL nor the designer has to hold an
 * opinion about a target that was never writable in the first place.
 */
export const workflowDocumentSchema = z
  .object({
    format: z.literal(WORKFLOW_DOCUMENT_FORMAT),
    version: z.literal(WORKFLOW_DOCUMENT_VERSION),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable().default(null),
    steps: z.array(workflowDocumentStepSchema).min(1).max(200),
  })
  .superRefine((doc, ctx) => {
    doc.steps.forEach((step, index) => {
      if (!step.branch) return;
      for (const key of ["thenStep", "elseStep"] as const) {
        const target = step.branch[key];
        if (target !== null && target >= doc.steps.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "branch", key],
            message: `branch target ${target} names no step`,
          });
        }
      }
    });
  });
export type WorkflowDocument = z.infer<typeof workflowDocumentSchema>;

export const exportWorkflowInput = z.object({ id: idSchema });
export type ExportWorkflowInput = z.infer<typeof exportWorkflowInput>;

/**
 * `name` overrides the document's own, which is what makes importing a pipeline twice possible:
 * Workflow names are unique per Workspace, so a second import of the same document would collide.
 * Omitted, the import takes the document's name and suffixes it — "Ship (2)" — rather than
 * refusing, because the operator asked for the pipeline, not for the name.
 *
 * `fallbackHarnessProfileId` is where Steps land whose named profile this Workspace does not have.
 * Omitted, the import uses the first Harness Profile by name. Either way the substitution is
 * reported back, never silent.
 */
export const importWorkflowInput = z.object({
  document: workflowDocumentSchema,
  name: z.string().min(1).max(120).optional(),
  fallbackHarnessProfileId: idSchema.optional(),
});
export type ImportWorkflowInput = z.infer<typeof importWorkflowInput>;

/**
 * What the import created and what it could not carry across.
 *
 * The unresolved names are the point of returning anything more than the Workflow: an import that
 * quietly re-pointed four Steps at the wrong harness looks identical, in the designer, to one that
 * matched everything — until it runs.
 */
export const workflowImportDto = z.object({
  workflow: workflowWithStepsDto,
  /** Harness Profile names the document asked for that this Workspace has nothing called. */
  unmatchedHarnessProfiles: z.array(z.string()),
  /** MCP server names dropped from the Steps that asked for them. */
  unmatchedMcpServers: z.array(z.string()),
  /** Skill names dropped from the Steps that asked for them. */
  unmatchedSkills: z.array(z.string()),
});
export type WorkflowImportDto = z.infer<typeof workflowImportDto>;

/**
 * Installing a pipeline from the store (`WORKFLOW_STORE` in `@solow/core`). `entryId` names the
 * catalog entry; `harnessProfileId` is the Profile every Step runs on, chosen here because the
 * catalog has no opinion about harnesses. `name` overrides the entry's title, for the same reason
 * `importWorkflowInput.name` exists: the store is the ordinary way to install a pipeline twice.
 */
export const installWorkflowFromStoreInput = z.object({
  entryId: z.string().min(1).max(120),
  harnessProfileId: idSchema,
  name: z.string().min(1).max(120).optional(),
});
export type InstallWorkflowFromStoreInput = z.infer<typeof installWorkflowFromStoreInput>;

/**
 * What the install wrote. The Skills are named both ways because the difference is the point:
 * a `reused` Skill is one the library already held under that name — the upstream one, imported
 * from the method's repository — and the bundled text was *not* written over it.
 */
export const workflowStoreInstallDto = z.object({
  workflow: workflowWithStepsDto,
  /** Bundled Skills the library had nothing called, written as inline text, switched off. */
  createdSkills: z.array(z.string()),
  /** Skills the library already held by name; the Steps bind to those. */
  reusedSkills: z.array(z.string()),
});
export type WorkflowStoreInstallDto = z.infer<typeof workflowStoreInstallDto>;

/** One store entry, as `workflow.store` lists it: enough to choose and to install by id. */
export const workflowStoreEntryDto = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  category: z.string(),
  vendor: z.string(),
  homepage: z.string(),
  steps: z.array(z.string()),
  skills: z.array(z.string()),
});
export const workflowStoreListDto = z.array(workflowStoreEntryDto);
export type WorkflowStoreEntryDto = z.infer<typeof workflowStoreEntryDto>;
