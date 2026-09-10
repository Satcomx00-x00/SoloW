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
  type ImportWorkflowInput,
  type InstallWorkflowFromStoreInput,
  ok,
  type RenameWorkflowInput,
  type ReorderWorkflowStepInput,
  type Result,
  type TaskState,
  type TaskWorkflowBindingDto,
  type UpdateWorkflowStepInput,
  type WorkflowAdvanceDto,
  type WorkflowDocument,
  type WorkflowDto,
  WorkflowErrorCode,
  type WorkflowImportDto,
  type WorkflowListDto,
  type WorkflowStepBranch,
  type WorkflowStoreInstallDto,
  type WorkflowWithStepsDto,
} from "@solow/contracts";
import {
  appendRank,
  planWorkflowImport,
  rankBetween,
  rankForMove,
  resumeWorkflowCursor,
  sortSteps,
  validateWorkflowGraph,
  workflowStoreDocument,
  workflowStoreEntry,
  workflowStoreSkills,
  workflowToDocument,
} from "@solow/core";
import {
  advanceTaskWorkflow as advanceTaskWorkflowIn,
  harnessProfile,
  loadTaskWorkflowRun,
  mcpServer,
  skill,
  stepsToDto,
  task,
  workflow,
  workflowStep,
} from "@solow/db";
import { and, asc, eq, sql } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { checkStepTools, createSkill } from "./harness-library.js";

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

      // "In use" means a Task that could still move along it. A finished Task's binding is a
      // record of which pipeline ran it — worth keeping while the pipeline exists, and nothing
      // to keep once it does not — so `done` and `failed` are unbound rather than counted, or a
      // Workflow that ever ran a Task could never be deleted.
      const followers = tx
        .select({ id: task.id, state: task.state })
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.workflowId, id)))
        .all();
      if (followers.some((t) => !finished(t.state))) return err(WorkflowErrorCode.InUse);
      if (followers.length > 0) {
        tx.update(task)
          .set(UNBOUND)
          .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.workflowId, id)))
          .run();
      }

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
 * A Workflow as a portable document (`workflowDocumentSchema`).
 *
 * The three catalogues are read whole rather than by the ids the Steps happen to use: a Workspace
 * has tens of these rows, not thousands, and one query each is cheaper than an `IN` list built
 * from a set union — and it keeps this function a read of the Workspace rather than a read
 * derived from the Steps it is already holding.
 */
export async function exportWorkflow(
  ctx: RequestContext,
  id: string,
): Promise<Result<WorkflowDocument, NotFound>> {
  const found = await getWorkflowWithSteps(ctx, id);
  if (!found.ok) return err(found.error);

  const byId = (rows: readonly { id: string; name: string }[]) =>
    new Map(rows.map((row) => [row.id, row.name]));

  const profiles = await ctx.db
    .select({ id: harnessProfile.id, name: harnessProfile.name })
    .from(harnessProfile)
    .where(eq(harnessProfile.workspaceId, ctx.workspaceId));
  const servers = await ctx.db
    .select({ id: mcpServer.id, name: mcpServer.name })
    .from(mcpServer)
    .where(eq(mcpServer.workspaceId, ctx.workspaceId));
  const skills = await ctx.db
    .select({ id: skill.id, name: skill.name })
    .from(skill)
    .where(eq(skill.workspaceId, ctx.workspaceId));

  return ok(
    workflowToDocument(found.data, found.data.steps, {
      harnessProfile: byId(profiles),
      mcpServer: byId(servers),
      skill: byId(skills),
    }),
  );
}

/**
 * Write an imported document as a new Workflow, resolved against this Workspace's catalogues.
 *
 * One `immediate` transaction, like every other ordering write here: a half-written pipeline —
 * a Workflow row with three of its five Steps — is not a state the designer can show or the
 * operator can fix, and the unique name is claimed by the same statement that uses it.
 *
 * Branches are written in a **second pass**. A branch names Steps by index because the document
 * has no ids; the ids only exist once the rows are inserted, so the first pass writes every Step
 * with no branch and the second re-points them. Doing it in one pass would mean either inserting
 * backwards — impossible for a branch that points forwards — or minting ids by hand.
 *
 * The new Workflow stays at version 1. The version counter is "how many times has this definition
 * been edited underneath an attached Task", and the answer for a Workflow that has existed for a
 * millisecond is none; bumping it once per Step would make a five-Step import look like a
 * pipeline someone had already revised five times.
 */
export async function importWorkflow(
  ctx: RequestContext,
  input: ImportWorkflowInput,
): Promise<Result<WorkflowImportDto, StepWriteError>> {
  const written = ctx.db.transaction(
    (
      tx,
    ): Result<
      { workflowId: string; unmatched: Omit<WorkflowImportDto, "workflow"> },
      StepWriteError
    > => {
      const catalog = {
        harnessProfiles: tx
          .select({ id: harnessProfile.id, name: harnessProfile.name })
          .from(harnessProfile)
          .where(eq(harnessProfile.workspaceId, ctx.workspaceId))
          .all(),
        mcpServers: tx
          .select({ id: mcpServer.id, name: mcpServer.name })
          .from(mcpServer)
          .where(eq(mcpServer.workspaceId, ctx.workspaceId))
          .all(),
        skills: tx
          .select({ id: skill.id, name: skill.name })
          .from(skill)
          .where(eq(skill.workspaceId, ctx.workspaceId))
          .all(),
      };

      // A caller-named fallback is still a caller-supplied id, so it is resolved through this
      // Workspace before it can be written to every Step (Principle V).
      if (
        input.fallbackHarnessProfileId !== undefined &&
        !catalog.harnessProfiles.some((p) => p.id === input.fallbackHarnessProfileId)
      ) {
        return err(CommonErrorCode.NotFound);
      }

      const taken = tx
        .select({ name: workflow.name })
        .from(workflow)
        .where(eq(workflow.workspaceId, ctx.workspaceId))
        .all()
        .map((row) => row.name);

      const plan = planWorkflowImport(input.document, catalog, {
        name: input.name,
        fallbackProfileId: input.fallbackHarnessProfileId,
        taken,
      });
      if (!plan) return err(WorkflowErrorCode.NoHarnessProfile);

      const [created] = tx
        .insert(workflow)
        .values({
          workspaceId: ctx.workspaceId,
          name: plan.name,
          description: plan.description,
        })
        .returning()
        .all();
      if (!created) return err(CommonErrorCode.ValidationFailed);

      const ids: string[] = [];
      let rank: string | null = null;
      for (const step of plan.steps) {
        rank = appendRank(rank);
        const [row] = tx
          .insert(workflowStep)
          .values({
            workspaceId: ctx.workspaceId,
            workflowId: created.id,
            rank,
            name: step.name,
            agentProfileId: step.agentProfileId,
            promptTemplate: step.promptTemplate,
            gate: step.gate,
            advanceOn: step.advanceOn,
            onEnter: step.onEnter,
            branch: null,
            mcpServerIds: step.mcpServerIds,
            skillIds: step.skillIds,
            permissionMode: step.permissionMode,
          })
          .returning({ id: workflowStep.id })
          .all();
        if (!row) return err(CommonErrorCode.ValidationFailed);
        ids.push(row.id);
      }

      plan.steps.forEach((step, index) => {
        if (!step.branch) return;
        const target = (at: number | null) => (at === null ? null : (ids[at] ?? null));
        const self = ids[index];
        const branch: WorkflowStepBranch = {
          when: step.branch.when,
          thenStepId: target(step.branch.thenStep),
          elseStepId: target(step.branch.elseStep),
        };
        // A branch onto its own Step is refused on write for a reason that survives the trip —
        // it would move no cursor, defeating the `StaleCursor` replay guard — so a document
        // carrying one loses that side rather than importing an unrunnable pipeline.
        if (branch.thenStepId === self) branch.thenStepId = null;
        if (branch.elseStepId === self) branch.elseStepId = null;
        tx.update(workflowStep)
          .set({ branch })
          .where(
            and(eq(workflowStep.workspaceId, ctx.workspaceId), eq(workflowStep.id, self ?? "")),
          )
          .run();
      });

      return ok({
        workflowId: created.id,
        unmatched: {
          unmatchedHarnessProfiles: plan.unmatchedHarnessProfiles,
          unmatchedMcpServers: plan.unmatchedMcpServers,
          unmatchedSkills: plan.unmatchedSkills,
        },
      });
    },
    { behavior: "immediate" },
  );
  if (!written.ok) return err(written.error);

  const created = await getWorkflowWithSteps(ctx, written.data.workflowId);
  return created.ok
    ? ok({ workflow: created.data, ...written.data.unmatched })
    : err(created.error);
}

/**
 * Install a pipeline from the store: the catalog entry as a document, imported onto one Harness
 * Profile, with the Skills its Steps name added to the library first.
 *
 * The Skills go in **by name, only where the library has nothing of that name** — never
 * overwritten. That rule is what makes the store a way of loading Spec Kit, Superpowers or
 * OpenSpec without bundling them: an operator who imported the method's own Skills from its
 * repository beforehand gets a pipeline bound to those, and the condensed text the catalog
 * carries is only the fallback. Every bundled Skill is written switched off, like everything
 * the store writes: a Step names it, so it is loaded where it is needed and nowhere else.
 *
 * Two writes rather than one transaction, deliberately: `createSkill` is the library's own
 * write and keeps its rule (one name, one row), and `importWorkflow` is the document's, with
 * its own. A Skill left behind by an import that then failed is an ordinary library row the
 * operator can see and remove — not a half-written pipeline, which is the state the import's
 * transaction exists to prevent.
 */
export async function installWorkflowFromStore(
  ctx: RequestContext,
  input: InstallWorkflowFromStoreInput,
): Promise<Result<WorkflowStoreInstallDto, StepWriteError>> {
  const entry = workflowStoreEntry(input.entryId);
  if (!entry) return err(CommonErrorCode.NotFound);

  const [profile] = await ctx.db
    .select({ id: harnessProfile.id, name: harnessProfile.name })
    .from(harnessProfile)
    .where(
      and(
        eq(harnessProfile.workspaceId, ctx.workspaceId),
        eq(harnessProfile.id, input.harnessProfileId),
      ),
    )
    .limit(1);
  if (!profile) return err(CommonErrorCode.NotFound);

  const held = new Set(
    (
      await ctx.db
        .select({ name: skill.name })
        .from(skill)
        .where(eq(skill.workspaceId, ctx.workspaceId))
    ).map((row) => row.name),
  );
  const createdSkills: string[] = [];
  const reusedSkills: string[] = [];
  for (const bundled of workflowStoreSkills(entry)) {
    if (held.has(bundled.name)) {
      reusedSkills.push(bundled.name);
      continue;
    }
    const created = await createSkill(ctx, {
      name: bundled.name,
      description: bundled.description,
      source: { kind: "inline", body: bundled.body },
      enabled: false,
    });
    if (!created.ok) return err(CommonErrorCode.ValidationFailed);
    createdSkills.push(bundled.name);
  }

  const imported = await importWorkflow(ctx, {
    document: workflowStoreDocument(entry, profile.name),
    ...(input.name !== undefined ? { name: input.name } : {}),
    // Every Step names this profile, so nothing should fall back; the id is passed anyway so a
    // second profile that happens to share the name cannot make the resolution a coin flip.
    fallbackHarnessProfileId: profile.id,
  });
  if (!imported.ok) return err(imported.error);
  return ok({ workflow: imported.data.workflow, createdSkills, reusedSkills });
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

/**
 * Can this branch be written on this Step? Its targets must be Steps of the same Workflow — a
 * foreign key would accept another Workflow's Step, and a null-means-end column cannot carry
 * one anyway — and never the Step itself, which would move no cursor and so defeat the
 * `StaleCursor` replay guard (see `WorkflowErrorCode.BranchTargetIsSelf`).
 *
 * `stepId` is null for a Step being added, which cannot be its own target because it has no id
 * yet — its targets are checked against the siblings it is about to join.
 */
function checkBranchTargets(
  branch: WorkflowStepBranch | null | undefined,
  stepId: string | null,
  siblings: readonly { id: string }[],
): Result<void, WorkflowErrorCode> {
  if (!branch) return ok(undefined);
  for (const target of [branch.thenStepId, branch.elseStepId]) {
    if (target === null) continue;
    if (target === stepId) return err(WorkflowErrorCode.BranchTargetIsSelf);
    if (!siblings.some((step) => step.id === target)) {
      return err(WorkflowErrorCode.StepNotInWorkflow);
    }
  }
  return ok(undefined);
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
      // another tenant's Harness Profile and inherit its credentials at run time (Principle V).
      const [profile] = tx
        .select({ id: harnessProfile.id })
        .from(harnessProfile)
        .where(
          and(
            eq(harnessProfile.workspaceId, ctx.workspaceId),
            eq(harnessProfile.id, input.agentProfileId),
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

      const targets = checkBranchTargets(input.branch, null, existing);
      if (!targets.ok) return err(targets.error);
      if (!checkStepTools(tx, ctx, input.mcpServerIds, input.skillIds)) {
        return err(WorkflowErrorCode.ToolNotInWorkspace);
      }

      let rank: string;
      if (input.afterStepId === null) {
        // At the head: the new Step becomes the start of the pipeline. Still one row written.
        const before = rankBetween(null, existing[0]?.rank ?? null);
        if (!before.ok) return err(before.error);
        rank = before.data;
      } else if (input.afterStepId) {
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
          branch: input.branch ?? null,
          mcpServerIds: [...new Set(input.mcpServerIds ?? [])],
          skillIds: [...new Set(input.skillIds ?? [])],
          permissionMode: input.permissionMode ?? null,
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
          .select({ id: harnessProfile.id })
          .from(harnessProfile)
          .where(
            and(
              eq(harnessProfile.workspaceId, ctx.workspaceId),
              eq(harnessProfile.id, input.agentProfileId),
            ),
          )
          .limit(1)
          .all();
        if (!profile) return err(CommonErrorCode.NotFound);
      }

      if (input.branch) {
        const siblings = tx
          .select({ id: workflowStep.id })
          .from(workflowStep)
          .where(
            and(
              eq(workflowStep.workspaceId, ctx.workspaceId),
              eq(workflowStep.workflowId, step.workflowId),
            ),
          )
          .all();
        const targets = checkBranchTargets(input.branch, step.id, siblings);
        if (!targets.ok) return err(targets.error);
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
      if (
        input.branch !== undefined &&
        JSON.stringify(input.branch ?? null) !== JSON.stringify(step.branch ?? null)
      ) {
        patch.branch = input.branch;
      }
      // The libraries a Step loads (spec F24): whole lists, de-duplicated, every id checked
      // against this Workspace's rows before it is written.
      if (input.mcpServerIds !== undefined || input.skillIds !== undefined) {
        if (!checkStepTools(tx, ctx, input.mcpServerIds, input.skillIds)) {
          return err(WorkflowErrorCode.ToolNotInWorkspace);
        }
        const nextMcp = [...new Set(input.mcpServerIds ?? step.mcpServerIds)];
        const nextSkills = [...new Set(input.skillIds ?? step.skillIds)];
        if (JSON.stringify(nextMcp) !== JSON.stringify(step.mcpServerIds)) {
          patch.mcpServerIds = nextMcp;
        }
        if (JSON.stringify(nextSkills) !== JSON.stringify(step.skillIds)) {
          patch.skillIds = nextSkills;
        }
      }
      // Null is a value here, not an absence: it hands the posture back to the Harness Profile.
      // So the test is `!== undefined`, and `!== step.permissionMode` is what keeps a form saved
      // twice from bumping the version and raising drift on every attached Task.
      if (
        input.permissionMode !== undefined &&
        input.permissionMode !== (step.permissionMode ?? null)
      ) {
        patch.permissionMode = input.permissionMode;
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
 *
 * Refused, too, while another Step's branch names it. The alternative was to null the reference
 * out, and null has a meaning here — "the pipeline ends" — so a silent patch would rewrite a
 * branch the operator wrote into one they did not.
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

      // Same rule as `deleteWorkflow`: a Task that finished on this Step no longer holds it. It
      // is unbound from the whole pipeline rather than left pointing at a Step that is gone —
      // a binding with no current Step is one `taskBinding` cannot describe.
      const parked = tx
        .select({ id: task.id, state: task.state })
        .from(task)
        .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.workflowStepId, step.id)))
        .all();
      if (parked.some((t) => !finished(t.state))) return err(WorkflowErrorCode.StepInUse);
      if (parked.length > 0) {
        tx.update(task)
          .set(UNBOUND)
          .where(and(eq(task.workspaceId, ctx.workspaceId), eq(task.workflowStepId, step.id)))
          .run();
      }

      const siblings = tx
        .select({ id: workflowStep.id, branch: workflowStep.branch })
        .from(workflowStep)
        .where(
          and(
            eq(workflowStep.workspaceId, ctx.workspaceId),
            eq(workflowStep.workflowId, step.workflowId),
          ),
        )
        .all();
      const pointedAt = siblings.some(
        (other) =>
          other.id !== step.id &&
          (other.branch?.thenStepId === step.id || other.branch?.elseStepId === step.id),
      );
      if (pointedAt) return err(WorkflowErrorCode.StepBranchedTo);

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
 * two Steps of paid harness work discarded with no error, which is the outcome
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
 * harness is already running would change what that run is for, mid-run. Refused for an empty
 * Workflow, because a cursor has to name something for the resume rule to have an answer — and
 * for a graph with a Step nothing leads to or no way to the end (`validateWorkflowGraph`).
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
      // The designer only *shows* an unreachable Step or a loop with no way out, because an
      // operator building a loop passes through both. Here is where they cost something: a
      // Task must not be started down a pipeline that skips a Step or can never finish.
      if (validateWorkflowGraph(steps).length > 0) return err(WorkflowErrorCode.GraphInvalid);

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
/** A Task that will not move again, whatever pipeline it was on. */
const finished = (state: TaskState): boolean => state === "done" || state === "failed";

/** Every column a binding writes, cleared — what `detachTaskWorkflow` writes, shared. */
const UNBOUND = {
  workflowId: null,
  workflowStepId: null,
  workflowVersion: null,
  workflowHandoff: null,
  workflowPendingHandoff: null,
  workflowDecisionId: null,
} as const;

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
        .set({ ...UNBOUND, updatedAt: now() })
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

/**
 * The two run-time entry points live in `@solow/db` — the orchestrator advances the same Task
 * from inside a durable step and cannot import from `apps/web`, and a second copy of the
 * transaction would be a second copy of `unspentApproval` and `producedChanges`, the two inputs
 * to a Principle I gate.
 *
 * They are delegated to rather than re-exported so the router and its regression suite keep the
 * `RequestContext` signatures they already call — and so the session-to-`workspaceId` unwrap
 * stays at this boundary, which is where Principle V is enforced for every web caller.
 */
export function getTaskWorkflowBinding(
  ctx: RequestContext,
  taskId: string,
): Promise<Result<TaskWorkflowBindingDto, NotFound | WorkflowErrorCode>> {
  return loadTaskWorkflowRun(ctx.db, ctx.workspaceId, taskId);
}

export function advanceTaskWorkflow(
  ctx: RequestContext,
  input: AdvanceTaskWorkflowInput,
): Promise<Result<WorkflowAdvanceDto, NotFound | WorkflowErrorCode>> {
  return advanceTaskWorkflowIn(ctx.db, ctx.workspaceId, input);
}
