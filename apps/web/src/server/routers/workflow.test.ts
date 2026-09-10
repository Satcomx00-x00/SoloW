/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { CommonErrorCode, WorkflowErrorCode } from "@solow/contracts";
import { VENDORED_STORE, WORKFLOW_STORE, workflowStoreDocument } from "@solow/core";
import {
  ensureDefaultHarnessCatalog,
  issue as issueTable,
  review as reviewTable,
  sessionEvent as sessionEventTable,
  session as sessionTable,
  task as taskTable,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { findMcpTool, listMcpTools } from "../mcp/tools.js";
import { resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * Workflow integration tests (issue #5) against a real in-memory SQLite database, so the two
 * tables, the unique rank index and the Workspace scoping are exercised rather than described.
 *
 * The ordering and advance rules themselves are unit-tested in `@solow/core`. What is
 * proved here is that the router reaches for them before writing, that the durable cursor is
 * what a later read actually gets back, and that the last Step cannot be finished without a
 * `review` row no matter how the Steps are configured (Principle I).
 */

function ctx(db: TestDb, workspaceId: string, flags?: Partial<BaseContext["flagOverrides"]>) {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    // `ff-agent-libraries` because a Step loads MCP servers and Skills, and a shared document
    // has to carry those by name — see the export/import suite.
    flagOverrides: {
      "ff-core-program": true,
      "ff-workflows": true,
      "ff-agent-libraries": true,
      ...flags,
    },
  } satisfies BaseContext;
}

function caller(db: TestDb, workspaceId: string, flags?: Partial<BaseContext["flagOverrides"]>) {
  return appRouter.createCaller(ctx(db, workspaceId, flags));
}

/** The id of the nth Step of a pipeline, so a walk through one reads as the walk it is. */
function steps(wf: { steps: readonly { id: string }[] }, index: number): string {
  const step = wf.steps[index];
  if (!step) throw new Error(`pipeline has no step ${index}`);
  return step.id;
}

/** Run a call and return the TRPCError code, or "OK" if it resolved. */
async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

/** Run a call and return the TRPCError message, or "OK" if it resolved. */
async function errMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { message?: string }).message ?? String(e);
  }
}

/** A Workspace with everything a Task and a Workflow Step need. */
async function fixture(db: TestDb, name: string) {
  const [ws] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");
  const wsId = ws.id;
  const c = caller(db, wsId);
  const agentCatalogId = await ensureDefaultHarnessCatalog(db, wsId);
  const { secret } = await c.secret.set({ name: "sub", kind: "subscription_token", value: "tok" });

  const harness = async (profileName: string) =>
    await c.profile.agent.create({
      name: profileName,
      agentCatalogId,
      authMode: "subscription",
      secretId: secret.id,
      concurrencyCap: 3,
    });
  const planner = await harness("Opus");
  const implementer = await harness("Copilot");
  const reviewer = await harness("Codex");

  const executor = await c.profile.executor.create({ name: "Local" });
  const repo = await c.repository.connect({
    name: "repo",
    source: "local_path",
    location: `/srv/${name}`,
  });
  const [issue] = await db
    .insert(issueTable)
    .values({ workspaceId: wsId, title: "Fix latch" })
    .returning();
  if (!issue) throw new Error("failed to seed issue");

  const newTask = async (title: string) =>
    await c.task.create({
      issueId: issue.id,
      title,
      agentProfileId: planner.id,
      executorProfileId: executor.id,
      repositories: [{ repositoryId: repo.id }],
    });

  /**
   * The pipeline the issue is written around: one harness plans, another implements, a
   * third reviews — three Steps, three different Harness Profiles, one Workflow.
   */
  const newPipeline = async (
    workflowName: string,
    gate: "human" | "auto" | "auto-unless-changes" = "auto",
  ) => {
    const wf = await c.workflow.create({ name: workflowName });
    for (const [stepName, profile] of [
      ["Plan", planner],
      ["Implement", implementer],
      ["Review", reviewer],
    ] as const) {
      await c.workflow.addStep({
        workflowId: wf.id,
        name: stepName,
        agentProfileId: profile.id,
        promptTemplate: `${stepName} the change.`,
        gate,
        advanceOn: "agent-signal",
      });
    }
    return await c.workflow.get({ id: wf.id });
  };

  return { wsId, c, planner, implementer, reviewer, newTask, newPipeline };
}

/**
 * Record a human decision the way the product does: a Session for the Task, and a `review` row
 * against it. Inserted directly because the point is the *row*, not the review flow — and
 * `advanceTaskWorkflow` reads the table, never its caller's word for it (Principle I).
 *
 * The decision is a parameter because the table holds all three: `reject` and `request_changes`
 * are a human looking at the work and refusing it, and a gate that counted them would be reading
 * a refusal as consent.
 */
async function recordDecision(
  db: TestDb,
  wsId: string,
  taskId: string,
  decision: "approve" | "reject" | "request_changes" = "approve",
): Promise<void> {
  const [s] = await db
    .insert(sessionTable)
    .values({ workspaceId: wsId, taskId, state: "awaiting_review" })
    .returning();
  if (!s) throw new Error("failed to seed session");
  await db
    .insert(reviewTable)
    .values({ workspaceId: wsId, sessionId: s.id, decision, actorUserId: "user-1" });
}

/** Record the server's own evidence that a Task's work produced a diff (the `diff` session event). */
async function recordDiff(db: TestDb, wsId: string, taskId: string): Promise<void> {
  const [s] = await db
    .insert(sessionTable)
    .values({ workspaceId: wsId, taskId, state: "awaiting_review", diffRef: "solow/task" })
    .returning();
  if (!s) throw new Error("failed to seed session");
  await db.insert(sessionEventTable).values({
    workspaceId: wsId,
    sessionId: s.id,
    seq: 1,
    kind: "diff",
    payload: {
      kind: "diff",
      diffRef: "solow/task",
      files: [{ path: "latch.ts", status: "modified", additions: 3, deletions: 1 }],
      patch: "",
      truncated: false,
    },
  });
}

describe("workflows", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
    process.env.SOLOW_STREAM_SECRET ??= "test-stream-secret";
    process.env.SOLOW_AUTH_SECRET ??= "test-auth-secret";
    process.env.SOLOW_DEV_OWNER ??= "on";
  });

  beforeEach(() => {
    db = createTestDb();
    resetRateLimits();
  });

  describe("AC-1 — designing a workflow of ordered steps", () => {
    it("lists steps in the order they were added, each with its own harness profile", async () => {
      const { c, planner, implementer, reviewer } = await fixture(db, "acme");
      const wf = await c.workflow.get({ id: (await c.workflow.create({ name: "Ship" })).id });

      for (const [name, profile] of [
        ["Plan", planner],
        ["Implement", implementer],
        ["Review", reviewer],
      ] as const) {
        await c.workflow.addStep({ workflowId: wf.id, name, agentProfileId: profile.id });
      }

      const after = await c.workflow.get({ id: wf.id });
      expect(after.steps.map((s) => s.name)).toEqual(["Plan", "Implement", "Review"]);
      expect(after.steps.map((s) => s.position)).toEqual([0, 1, 2]);
      // AC-3, expressed in the model: one Task, three Steps, three different harnesses.
      expect(after.steps.map((s) => s.agentProfileId)).toEqual([
        planner.id,
        implementer.id,
        reviewer.id,
      ]);
      expect(new Set(after.steps.map((s) => s.agentProfileId)).size).toBe(3);
    });

    it("keeps each step's gate and advance rule", async () => {
      const { c, planner } = await fixture(db, "acme");
      const wf = await c.workflow.create({ name: "Ship" });
      const after = await c.workflow.addStep({
        workflowId: wf.id,
        name: "Plan",
        agentProfileId: planner.id,
        gate: "auto-unless-changes",
        advanceOn: "agent-signal",
        promptTemplate: "Draw up a plan.",
      });
      expect(after.steps[0]).toMatchObject({
        gate: "auto-unless-changes",
        advanceOn: "agent-signal",
        promptTemplate: "Draw up a plan.",
      });
    });

    it("inserts a step in the middle without touching either neighbour", async () => {
      const { c, planner, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const [first, second] = wf.steps;
      if (!first || !second) throw new Error("pipeline");

      const after = await c.workflow.addStep({
        workflowId: wf.id,
        name: "Spike",
        agentProfileId: planner.id,
        afterStepId: first.id,
      });

      expect(after.steps.map((s) => s.name)).toEqual(["Plan", "Spike", "Implement", "Review"]);
      // The whole reason ranks are strings: exactly one row was written.
      const untouched = after.steps.filter((s) => s.id === first.id || s.id === second.id);
      expect(untouched.map((s) => s.rank)).toEqual([first.rank, second.rank]);
      expect(untouched.map((s) => s.updatedAt)).toEqual([first.updatedAt, second.updatedAt]);
    });

    it("puts a step at the head when afterStepId is null, making it the new start", async () => {
      const { c, planner, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const before = wf.steps.map((s) => s.updatedAt);

      const after = await c.workflow.addStep({
        workflowId: wf.id,
        name: "Triage",
        agentProfileId: planner.id,
        afterStepId: null,
      });
      expect(after.steps.map((s) => s.name)).toEqual(["Triage", "Plan", "Implement", "Review"]);
      // One row written: nothing that was already there was touched.
      expect(after.steps.slice(1).map((s) => s.updatedAt)).toEqual(before);
    });

    it("moves a step between two named neighbours", async () => {
      const { c, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const [plan, , review] = wf.steps;
      if (!plan || !review) throw new Error("pipeline");

      const after = await c.workflow.reorderStep({
        stepId: review.id,
        afterStepId: null,
        beforeStepId: plan.id,
      });
      expect(after.steps.map((s) => s.name)).toEqual(["Review", "Plan", "Implement"]);
    });

    it("refuses a move whose neighbours are no longer adjacent", async () => {
      const { c, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const [plan, implement] = wf.steps;
      if (!plan || !implement) throw new Error("pipeline");

      const message = await errMessage(() =>
        c.workflow.reorderStep({
          stepId: plan.id,
          afterStepId: implement.id,
          beforeStepId: null,
        }),
      );
      expect(message).toBe(WorkflowErrorCode.StaleOrder);
    });

    it("refuses two workflows with the same name, so a select is never a coin flip", async () => {
      const { c } = await fixture(db, "acme");
      await c.workflow.create({ name: "Ship" });
      expect(await errCode(() => c.workflow.create({ name: "Ship" }))).not.toBe("OK");
    });
  });

  describe("Principle V — one Workspace cannot see or touch another's workflow", () => {
    it("does not find another Workspace's workflow, or write into it", async () => {
      const acme = await fixture(db, "acme");
      const other = await fixture(db, "other");
      const theirs = await acme.newPipeline("Ship");
      const step = theirs.steps[0];
      if (!step) throw new Error("pipeline");
      const mine = await other.newTask("Mine");

      // The other Workspace sees its own defaults (seeded with its first Profile), never "Ship".
      expect((await other.c.workflow.list({})).map((w) => w.id)).not.toContain(theirs.id);
      expect(await errCode(() => other.c.workflow.get({ id: theirs.id }))).toBe("NOT_FOUND");
      expect(
        await errCode(() =>
          other.c.workflow.addStep({
            workflowId: theirs.id,
            name: "Sneak",
            agentProfileId: other.planner.id,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(
        await errCode(() => other.c.workflow.updateStep({ stepId: step.id, name: "Sneak" })),
      ).toBe("NOT_FOUND");
      expect(
        await errCode(() =>
          other.c.workflow.reorderStep({
            stepId: step.id,
            afterStepId: null,
            beforeStepId: null,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect(await errCode(() => other.c.workflow.deleteStep({ stepId: step.id }))).toBe(
        "NOT_FOUND",
      );
      expect(
        await errCode(() =>
          other.c.workflow.attachTask({ taskId: mine.id, workflowId: theirs.id }),
        ),
      ).toBe("NOT_FOUND");
      expect(await errCode(() => other.c.workflow.delete({ id: theirs.id }))).toBe("NOT_FOUND");

      // And the attempted writes changed nothing.
      const still = await acme.c.workflow.get({ id: theirs.id });
      expect(still.steps.map((s) => s.name)).toEqual(["Plan", "Implement", "Review"]);
    });

    it("refuses a step naming another Workspace's harness profile before any row is written", async () => {
      const acme = await fixture(db, "acme");
      const other = await fixture(db, "other");
      const wf = await acme.c.workflow.create({ name: "Ship" });

      expect(
        await errCode(() =>
          acme.c.workflow.addStep({
            workflowId: wf.id,
            name: "Sneak",
            agentProfileId: other.planner.id,
          }),
        ),
      ).toBe("NOT_FOUND");
      expect((await acme.c.workflow.get({ id: wf.id })).steps).toHaveLength(0);
    });
  });

  describe("AC-2 / AC-5 — a Task on a workflow", () => {
    it("starts a task at the first step and records the definition version", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");

      const binding = await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      expect(binding.currentStep.name).toBe("Plan");
      expect(binding.attachedVersion).toBe(wf.version);
      expect(binding.definitionDrifted).toBe(false);
      expect(binding.brief).toBe("Plan the change.");
    });

    it("refuses to attach a workflow that has no steps", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const wf = await c.workflow.create({ name: "Empty" });
      const t = await newTask("Wire the latch");
      expect(
        await errMessage(() => c.workflow.attachTask({ taskId: t.id, workflowId: wf.id })),
      ).toBe(WorkflowErrorCode.Empty);
    });

    it("refuses to attach a workflow whose graph skips a step or can never end", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      const branch = (thenStepId: string | null, elseStepId: string | null) => ({
        when: { kind: "agent-decides" as const, question: "?" },
        thenStepId,
        elseStepId,
      });

      // Plan skips Implement on both exits: Implement never runs.
      await c.workflow.updateStep({
        stepId: steps(wf, 0),
        branch: branch(steps(wf, 2), steps(wf, 2)),
      });
      expect(
        await errMessage(() => c.workflow.attachTask({ taskId: t.id, workflowId: wf.id })),
      ).toBe(WorkflowErrorCode.GraphInvalid);

      // Plan branches properly again, but Review always goes back: the pipeline cannot end.
      await c.workflow.updateStep({ stepId: steps(wf, 0), branch: null });
      await c.workflow.updateStep({
        stepId: steps(wf, 2),
        branch: branch(steps(wf, 1), steps(wf, 1)),
      });
      expect(
        await errMessage(() => c.workflow.attachTask({ taskId: t.id, workflowId: wf.id })),
      ).toBe(WorkflowErrorCode.GraphInvalid);

      // A loop that can end is a pipeline, not a fault.
      await c.workflow.updateStep({ stepId: steps(wf, 2), branch: branch(steps(wf, 1), null) });
      expect(
        (await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id })).currentStep.name,
      ).toBe("Plan");
    });

    it("refuses to attach a workflow to a task whose harness is already running", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.task.move({ id: t.id, to: "ready" });
      await c.task.move({ id: t.id, to: "running" });

      expect(
        await errMessage(() => c.workflow.attachTask({ taskId: t.id, workflowId: wf.id })),
      ).toBe(WorkflowErrorCode.TaskAlreadyStarted);
    });

    it("moves the same Task on to the next step, carrying the handoff — no second Task", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const before = await db.select().from(taskTable).where(eq(taskTable.workspaceId, wsId));
      const advance = await c.workflow.advanceTask({
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "agent-signal",
        producedChanges: false,
        handoff: "The plan is to replace the servo.",
      });
      const after = await db.select().from(taskTable).where(eq(taskTable.workspaceId, wsId));

      expect(advance.status).toBe("advanced");
      expect(after).toHaveLength(before.length);
      expect(advance.brief).toContain("The plan is to replace the servo.");
      expect(advance.brief).toContain("Implement the change.");

      const binding = await c.workflow.taskBinding({ taskId: t.id });
      expect(binding.currentStep.name).toBe("Implement");
      expect(binding.handoff).toBe("The plan is to replace the servo.");
    });

    it("holds the cursor when the signal is not the one the step advances on", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const advance = await c.workflow.advanceTask({
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "review",
        producedChanges: false,
      });
      expect(advance.status).toBe("held");
      expect((await c.workflow.taskBinding({ taskId: t.id })).currentStep.name).toBe("Plan");
    });

    it("writes the cursor durably, so a fresh read resumes on the step it left off at", async () => {
      // Principle III / AC-5. The assertion deliberately re-reads the *column*, not the
      // mutation's return value: what survives a process death is what is in the table.
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      await c.workflow.advanceTask({
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "agent-signal",
        producedChanges: false,
      });

      const [row] = await db.select().from(taskTable).where(eq(taskTable.id, t.id));
      const expected = wf.steps[1];
      if (!expected) throw new Error("pipeline");
      expect(row?.workflowStepId).toBe(expected.id);

      // A brand-new caller, as a restarted process would be, lands on the same Step.
      const restarted = caller(db, wsId);
      expect((await restarted.workflow.taskBinding({ taskId: t.id })).currentStep.name).toBe(
        "Implement",
      );
    });

    it("lets a finished Task go: deleting its Workflow or Step unbinds it rather than refusing", async () => {
      // A Workflow that had ever run a Task could otherwise never be deleted — the Task keeps
      // its binding after it is done, and "in use" used to count that.
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      await db.update(taskTable).set({ state: "done" }).where(eq(taskTable.id, t.id));

      const first = wf.steps[0];
      if (!first) throw new Error("pipeline");
      await c.workflow.deleteStep({ stepId: first.id });
      let row = await db.query.task.findFirst({ where: eq(taskTable.id, t.id) });
      expect(row?.workflowId).toBeNull();
      expect(row?.workflowStepId).toBeNull();

      // And the Workflow itself, with another finished Task on it.
      const u = await newTask("Oil the hinge");
      await c.workflow.attachTask({ taskId: u.id, workflowId: wf.id });
      await db.update(taskTable).set({ state: "failed" }).where(eq(taskTable.id, u.id));
      await c.workflow.delete({ id: wf.id });
      expect((await c.workflow.list({})).map((w) => w.id)).not.toContain(wf.id);
      row = await db.query.task.findFirst({ where: eq(taskTable.id, u.id) });
      expect(row?.workflowId).toBeNull();
    });

    it("still refuses while a Task is running on it", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      await db.update(taskTable).set({ state: "running" }).where(eq(taskTable.id, t.id));

      expect(await errMessage(() => c.workflow.delete({ id: wf.id }))).toBe(
        WorkflowErrorCode.InUse,
      );
    });

    it("reports a definition edited underneath a running Task as drift", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      const step = wf.steps[2];
      if (!step) throw new Error("pipeline");

      await c.workflow.updateStep({ stepId: step.id, promptTemplate: "Review it twice." });

      const binding = await c.workflow.taskBinding({ taskId: t.id });
      expect(binding.currentVersion).toBeGreaterThan(binding.attachedVersion);
      expect(binding.definitionDrifted).toBe(true);
    });

    it("refuses to delete a step a Task is parked on, and the workflow it follows", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      const first = wf.steps[0];
      if (!first) throw new Error("pipeline");

      expect(await errMessage(() => c.workflow.deleteStep({ stepId: first.id }))).toBe(
        WorkflowErrorCode.StepInUse,
      );
      expect(await errMessage(() => c.workflow.delete({ id: wf.id }))).toBe(
        WorkflowErrorCode.InUse,
      );

      // Detaching the Task releases both.
      await c.workflow.detachTask({ taskId: t.id });
      await c.workflow.deleteStep({ stepId: first.id });
      await c.workflow.delete({ id: wf.id });
      expect((await c.workflow.list({})).map((w) => w.id)).not.toContain(wf.id);
    });

    it("refuses to read a binding for a Task that follows no workflow", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const t = await newTask("Wire the latch");
      expect(await errMessage(() => c.workflow.taskBinding({ taskId: t.id }))).toBe(
        WorkflowErrorCode.TaskNotOnWorkflow,
      );
    });
  });

  describe("AC-4 / Principle I — the gate never buys the right to finish", () => {
    it("will not complete the last step of an all-auto workflow without a review record", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      // Every gate is `auto`, so the first two steps pass without a human.
      const signal = (index: number) => ({
        taskId: t.id,
        fromStepId: steps(wf, index),
        signal: "agent-signal" as const,
        producedChanges: false,
      });
      expect((await c.workflow.advanceTask(signal(0))).status).toBe("advanced");
      expect((await c.workflow.advanceTask(signal(1))).status).toBe("advanced");
      expect((await c.workflow.taskBinding({ taskId: t.id })).currentStep.name).toBe("Review");

      // The last one does not.
      expect((await c.workflow.advanceTask(signal(2))).status).toBe("awaiting-decision");
      expect((await c.workflow.taskBinding({ taskId: t.id })).currentStep.name).toBe("Review");

      await recordDecision(db, wsId, t.id);
      expect((await c.workflow.advanceTask(signal(2))).status).toBe("completed");
    });

    it("follows the branch its condition chooses — back to an earlier step, or to the end", async () => {
      // The reviewer *harness* decides: asked whether the implementation needs another pass, its
      // `DECISION: yes` sends the Task back to Implement and its `DECISION: no` ends the pipeline.
      // The end reached through a branch is the same end Principle I guards.
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      await c.workflow.updateStep({
        stepId: steps(wf, 2),
        branch: {
          when: { kind: "agent-decides", question: "Does the implementation need another pass?" },
          thenStepId: steps(wf, 1),
          elseStepId: null,
        },
      });
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const signal = (index: number, handoff?: string) => ({
        taskId: t.id,
        fromStepId: steps(wf, index),
        signal: "agent-signal" as const,
        producedChanges: false,
        ...(handoff ? { handoff } : {}),
      });
      await c.workflow.advanceTask(signal(0));
      const onReview = await c.workflow.advanceTask(signal(1));
      // The reviewer is asked the question in its brief, in the words the branch will read.
      expect(onReview.brief).toContain("decide: Does the implementation need another pass?");
      expect(onReview.brief).toContain("`DECISION: yes` or `DECISION: no`");
      expect(onReview.brief).toContain(
        'If yes, the pipeline continues with "Implement"; if no, the pipeline ends.',
      );

      const back = await c.workflow.advanceTask(signal(2, "Missing tests.\nDECISION: yes"));
      expect(back.status).toBe("advanced");
      expect(back.currentStepId).toBe(steps(wf, 1));
      // The review's words are what the implementer is briefed with on the way back.
      expect(back.brief).toContain("Missing tests.");
      expect((await c.workflow.taskBinding({ taskId: t.id })).currentStep.name).toBe("Implement");

      await c.workflow.advanceTask(signal(1));
      expect((await c.workflow.advanceTask(signal(2, "Ship it.\nDECISION: no"))).status).toBe(
        "awaiting-decision",
      );
      await recordDecision(db, wsId, t.id);
      expect((await c.workflow.advanceTask(signal(2, "Ship it.\nDECISION: no"))).status).toBe(
        "completed",
      );
    });

    it("reads the branch back on the step, and refuses a target that is not a step of this workflow", async () => {
      const { c, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const other = await newPipeline("Other");
      const branch = {
        when: { kind: "produced-changes" as const },
        thenStepId: steps(wf, 2),
        elseStepId: null,
      };

      const written = await c.workflow.updateStep({ stepId: steps(wf, 0), branch });
      expect(written.steps[0]?.branch).toEqual(branch);
      expect(written.version).toBe(wf.version + 1);

      expect(
        await errMessage(() =>
          c.workflow.updateStep({
            stepId: steps(wf, 0),
            branch: { ...branch, thenStepId: steps(wf, 0) },
          }),
        ),
      ).toBe(WorkflowErrorCode.BranchTargetIsSelf);
      expect(
        await errMessage(() =>
          c.workflow.updateStep({
            stepId: steps(wf, 0),
            branch: { ...branch, elseStepId: steps(other, 1) },
          }),
        ),
      ).toBe(WorkflowErrorCode.StepNotInWorkflow);
      expect(
        await errMessage(() =>
          c.workflow.addStep({
            workflowId: wf.id,
            name: "Ship",
            agentProfileId: written.steps[0]?.agentProfileId ?? "",
            branch: { ...branch, thenStepId: steps(other, 0) },
          }),
        ),
      ).toBe(WorkflowErrorCode.StepNotInWorkflow);
    });

    it("refuses to delete a step another step still branches to", async () => {
      const { c, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      await c.workflow.updateStep({
        stepId: steps(wf, 2),
        branch: {
          when: { kind: "agent-decides", question: "Another pass?" },
          thenStepId: steps(wf, 1),
          elseStepId: null,
        },
      });

      expect(await errMessage(() => c.workflow.deleteStep({ stepId: steps(wf, 1) }))).toBe(
        WorkflowErrorCode.StepBranchedTo,
      );
      // Removing the branch releases it; a null branch is the rank order again.
      const cleared = await c.workflow.updateStep({ stepId: steps(wf, 2), branch: null });
      expect(cleared.steps[2]?.branch).toBeNull();
      expect((await c.workflow.deleteStep({ stepId: steps(wf, 1) })).steps).toHaveLength(2);
    });

    it("does not accept another Workspace's review as this Task's decision", async () => {
      const acme = await fixture(db, "acme");
      const other = await fixture(db, "other");
      const wf = await acme.newPipeline("Ship", "auto");
      const t = await acme.newTask("Wire the latch");
      const decoy = await other.newTask("Theirs");
      await acme.c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const signal = (index: number) => ({
        taskId: t.id,
        fromStepId: steps(wf, index),
        signal: "agent-signal" as const,
        producedChanges: false,
      });
      await acme.c.workflow.advanceTask(signal(0));
      await acme.c.workflow.advanceTask(signal(1));

      // A decision recorded in the other tenant, on a different Task, must not release this one.
      await recordDecision(db, other.wsId, decoy.id);
      expect((await acme.c.workflow.advanceTask(signal(2))).status).toBe("awaiting-decision");
    });

    it("holds an auto-unless-changes step that produced changes until a decision lands", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto-unless-changes");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const dirty = (index: number) => ({
        taskId: t.id,
        fromStepId: steps(wf, index),
        signal: "agent-signal" as const,
        producedChanges: true,
      });
      expect((await c.workflow.advanceTask(dirty(0))).status).toBe("awaiting-decision");
      await recordDecision(db, wsId, t.id);
      expect((await c.workflow.advanceTask(dirty(0))).status).toBe("advanced");
    });
  });

  /**
   * The regressions. Each of these was reproduced against this router before it was a test: the
   * gate rules were sound on paper and the question the database was asked was the wrong one.
   */
  describe("AC-4 / Principle I — what counts as a decision, and what it buys", () => {
    it("does not accept a rejection as the decision that finishes the workflow", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      // A human looked at the work and refused it. That is a recorded decision, and it is a
      // decision *not* to integrate.
      await recordDecision(db, wsId, t.id, "reject");

      const signal = (index: number) => ({
        taskId: t.id,
        fromStepId: steps(wf, index),
        signal: "agent-signal" as const,
        producedChanges: false,
      });
      await c.workflow.advanceTask(signal(0));
      await c.workflow.advanceTask(signal(1));
      expect((await c.workflow.advanceTask(signal(2))).status).toBe("awaiting-decision");

      // Nor does asking for changes, the other refusal the enum carries.
      await recordDecision(db, wsId, t.id, "request_changes");
      expect((await c.workflow.advanceTask(signal(2))).status).toBe("awaiting-decision");

      await recordDecision(db, wsId, t.id, "approve");
      expect((await c.workflow.advanceTask(signal(2))).status).toBe("completed");
    });

    it("stops treating an approval as current once it has been withdrawn", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const signal = (index: number) => ({
        taskId: t.id,
        fromStepId: steps(wf, index),
        signal: "agent-signal" as const,
        producedChanges: false,
      });
      await c.workflow.advanceTask(signal(0));
      await c.workflow.advanceTask(signal(1));

      await recordDecision(db, wsId, t.id, "approve");
      await recordDecision(db, wsId, t.id, "reject");
      expect((await c.workflow.advanceTask(signal(2))).status).toBe("awaiting-decision");
    });

    it("spends one approval on one human gate, so the next human gate needs its own", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "human");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const signal = (index: number) => ({
        taskId: t.id,
        fromStepId: steps(wf, index),
        signal: "agent-signal" as const,
        producedChanges: false,
      });
      expect((await c.workflow.advanceTask(signal(0))).status).toBe("awaiting-decision");

      // The Owner approves the plan. That releases the plan Step and nothing else — before, it
      // released every gate the Task had left and the last Step reported `completed`.
      await recordDecision(db, wsId, t.id);
      expect((await c.workflow.advanceTask(signal(0))).status).toBe("advanced");
      expect((await c.workflow.advanceTask(signal(1))).status).toBe("awaiting-decision");

      await recordDecision(db, wsId, t.id);
      expect((await c.workflow.advanceTask(signal(1))).status).toBe("advanced");
      expect((await c.workflow.advanceTask(signal(2))).status).toBe("awaiting-decision");

      await recordDecision(db, wsId, t.id);
      expect((await c.workflow.advanceTask(signal(2))).status).toBe("completed");

      // Three human-gated Steps, three recorded decisions. The count is the point.
      const reviews = await db.select().from(reviewTable).where(eq(reviewTable.workspaceId, wsId));
      expect(reviews).toHaveLength(3);
    });

    it("does not let one approval carry a second auto-unless-changes step that produced changes", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto-unless-changes");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const dirty = (index: number) => ({
        taskId: t.id,
        fromStepId: steps(wf, index),
        signal: "agent-signal" as const,
        producedChanges: true,
      });
      await recordDecision(db, wsId, t.id);
      expect((await c.workflow.advanceTask(dirty(0))).status).toBe("advanced");
      // The second dirty Step is a second change, and needs a second look.
      expect((await c.workflow.advanceTask(dirty(1))).status).toBe("awaiting-decision");
    });

    it("holds an auto-unless-changes step whose caller claims it changed nothing, when the log says otherwise", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto-unless-changes");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      // The server captured a diff for this Task at a review gate. `producedChanges: false` is
      // the caller's word about its own output; it is a floor on the answer, not the answer.
      await recordDiff(db, wsId, t.id);
      const clean = {
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "agent-signal" as const,
        producedChanges: false,
      };
      expect((await c.workflow.advanceTask(clean)).status).toBe("awaiting-decision");
    });
  });

  describe("Principle III — advancing is safe to replay", () => {
    it("refuses a redelivered advance rather than skipping the step it names", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      // A durable step re-runs after a process death with the byte-identical payload. Before, the
      // second delivery advanced the cursor again and "Implement" never ran.
      const payload = {
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "agent-signal" as const,
        producedChanges: false,
        handoff: "plan done",
      };
      expect((await c.workflow.advanceTask(payload)).status).toBe("advanced");
      expect(await errMessage(() => c.workflow.advanceTask(payload))).toBe(
        WorkflowErrorCode.StaleCursor,
      );
      expect((await c.workflow.taskBinding({ taskId: t.id })).currentStep.name).toBe("Implement");
    });

    it("keeps the harness's handoff when the gate holds, so the replay that moves the cursor still carries it", async () => {
      const { wsId, c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "human");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });

      const held = await c.workflow.advanceTask({
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "agent-signal",
        producedChanges: false,
        handoff: "The plan is to replace the servo.",
      });
      expect(held.status).toBe("awaiting-decision");

      // Whatever notices the decision replays the harness's signal, and it does not have the
      // harness's words — the server kept them.
      await recordDecision(db, wsId, t.id);
      const advanced = await c.workflow.advanceTask({
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "agent-signal",
        producedChanges: false,
      });
      expect(advanced.status).toBe("advanced");
      expect(advanced.brief).toContain("The plan is to replace the servo.");
      expect((await c.workflow.taskBinding({ taskId: t.id })).handoff).toBe(
        "The plan is to replace the servo.",
      );
    });
  });

  describe("attaching and detaching are guarded the same way", () => {
    it("refuses to re-attach a workflow to a Task that has already begun one", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      const other = await newPipeline("Rework", "auto");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      await c.workflow.advanceTask({
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "agent-signal",
        producedChanges: false,
        handoff: "The plan is to replace the servo.",
      });

      for (const workflowId of [wf.id, other.id]) {
        expect(await errMessage(() => c.workflow.attachTask({ taskId: t.id, workflowId }))).toBe(
          WorkflowErrorCode.TaskWorkflowInProgress,
        );
      }
      // The cursor and the handoff are exactly where the run left them.
      const binding = await c.workflow.taskBinding({ taskId: t.id });
      expect(binding.currentStep.name).toBe("Implement");
      expect(binding.handoff).toBe("The plan is to replace the servo.");
    });

    it("still allows re-attaching a Task that has not started its pipeline", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      const other = await newPipeline("Rework", "auto");
      const t = await newTask("Wire the latch");

      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      const binding = await c.workflow.attachTask({ taskId: t.id, workflowId: other.id });
      expect(binding.workflowName).toBe("Rework");
    });

    it("refuses to detach a Task that follows no workflow", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const t = await newTask("Wire the latch");
      expect(await errMessage(() => c.workflow.detachTask({ taskId: t.id }))).toBe(
        WorkflowErrorCode.TaskNotOnWorkflow,
      );
    });

    it("refuses to detach a running Task, so the step guards cannot be walked around", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      await c.task.move({ id: t.id, to: "ready" });
      await c.task.move({ id: t.id, to: "running" });

      expect(await errMessage(() => c.workflow.detachTask({ taskId: t.id }))).toBe(
        WorkflowErrorCode.TaskAlreadyStarted,
      );
      // Which is what keeps `deleteStep` refusing: detach-then-delete was the way around it.
      expect(await errMessage(() => c.workflow.deleteStep({ stepId: steps(wf, 0) }))).toBe(
        WorkflowErrorCode.StepInUse,
      );
    });
  });

  describe("a step's permission posture (spec F05, on the Step)", () => {
    it("defaults to null, which means the step's harness profile decides", async () => {
      const { newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      expect(wf.steps.map((s) => s.permissionMode)).toEqual([null, null, null]);
    });

    it("lets two steps of one pipeline run the same profile at different postures", async () => {
      // The case the field exists for: planning and building on one Harness Profile. Before this
      // it took two Profiles differing in a single enum, each with its own credential binding.
      const { c, planner } = await fixture(db, "acme");
      const wf = await c.workflow.create({ name: "Plan then build" });
      await c.workflow.addStep({
        workflowId: wf.id,
        name: "Plan",
        agentProfileId: planner.id,
        permissionMode: "plan",
      });
      const both = await c.workflow.addStep({
        workflowId: wf.id,
        name: "Build",
        agentProfileId: planner.id,
        permissionMode: "bypassPermissions",
      });

      expect(both.steps.map((s) => s.permissionMode)).toEqual(["plan", "bypassPermissions"]);
      expect(new Set(both.steps.map((s) => s.agentProfileId)).size).toBe(1);
    });

    it("hands the posture back to the profile when it is set to null", async () => {
      const { c, planner } = await fixture(db, "acme");
      const wf = await c.workflow.addStep({
        workflowId: (await c.workflow.create({ name: "Ship" })).id,
        name: "Plan",
        agentProfileId: planner.id,
        permissionMode: "plan",
      });
      const after = await c.workflow.updateStep({
        stepId: steps(wf, 0),
        permissionMode: null,
      });
      expect(after.steps[0]?.permissionMode).toBeNull();
    });

    it("does not bump the version for a posture set to the value it already had", async () => {
      // Null is a value here, not an absence, so the no-op check has to compare against null too
      // — a form saved twice must not raise drift on every attached Task.
      const { c, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      await c.workflow.updateStep({ stepId: steps(wf, 0), permissionMode: null });
      expect((await c.workflow.get({ id: wf.id })).version).toBe(wf.version);

      await c.workflow.updateStep({ stepId: steps(wf, 0), permissionMode: "plan" });
      const bumped = (await c.workflow.get({ id: wf.id })).version;
      expect(bumped).toBeGreaterThan(wf.version);
      await c.workflow.updateStep({ stepId: steps(wf, 0), permissionMode: "plan" });
      expect((await c.workflow.get({ id: wf.id })).version).toBe(bumped);
    });

    it("travels in an exported document and lands unchanged in another Workspace", async () => {
      const { c, planner } = await fixture(db, "acme");
      const wf = await c.workflow.create({ name: "Ship" });
      await c.workflow.addStep({
        workflowId: wf.id,
        name: "Plan",
        agentProfileId: planner.id,
        permissionMode: "plan",
      });
      await c.workflow.addStep({ workflowId: wf.id, name: "Build", agentProfileId: planner.id });

      const doc = await c.workflow.export({ id: wf.id });
      expect(doc.steps.map((s) => s.permissionMode)).toEqual(["plan", null]);

      const other = await fixture(db, "beta");
      const imported = await other.c.workflow.import({ document: doc });
      // A posture is one of three fixed values, not a name to resolve — so unlike a Skill it
      // cannot fail to match, and it arrives whatever the target Workspace has in it.
      expect(imported.workflow.steps.map((s) => s.permissionMode)).toEqual(["plan", null]);
    });
  });

  describe("sharing a pipeline — export and import", () => {
    /** A Workflow with a branch and a library load on it: everything a document has to carry. */
    async function shareable(c: Awaited<ReturnType<typeof fixture>>["c"], profileIds: string[]) {
      const server = await c.library.mcp.create({
        name: "playwright",
        transport: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp"] },
      });
      const sk = await c.library.skill.create({
        name: "impeccable",
        description: "Frontend design review.",
        source: { kind: "inline", body: "# impeccable" },
      });
      const wf = await c.workflow.create({ name: "Ship" });
      await c.workflow.addStep({
        workflowId: wf.id,
        name: "Implement",
        agentProfileId: profileIds[0] as string,
        promptTemplate: "Build it.",
        gate: "auto",
        advanceOn: "agent-signal",
        mcpServerIds: [server.id],
        skillIds: [sk.id],
      });
      const both = await c.workflow.addStep({
        workflowId: wf.id,
        name: "Review",
        agentProfileId: profileIds[1] as string,
        promptTemplate: "Review it.",
      });
      // "Changes requested, go back and implement" — a branch pointing at an earlier Step, which
      // is the case a document has to express without ids.
      await c.workflow.updateStep({
        stepId: steps(both, 1),
        branch: {
          when: { kind: "produced-changes" },
          thenStepId: steps(both, 0),
          elseStepId: null,
        },
      });
      return await c.workflow.get({ id: wf.id });
    }

    it("exports a document that names harnesses and tools, and carries no workspace ids", async () => {
      const { c, planner, reviewer } = await fixture(db, "acme");
      const wf = await shareable(c, [planner.id, reviewer.id]);

      const doc = await c.workflow.export({ id: wf.id });

      expect(doc.name).toBe("Ship");
      expect(doc.steps.map((s) => s.harnessProfile)).toEqual(["Opus", "Codex"]);
      expect(doc.steps[0]?.mcpServers).toEqual(["playwright"]);
      expect(doc.steps[0]?.skills).toEqual(["impeccable"]);
      expect(doc.steps[1]?.branch).toEqual({
        when: { kind: "produced-changes" },
        thenStep: 0,
        elseStep: null,
      });
      // The point of the format: nothing in it is an id of the Workspace it left.
      const serialised = JSON.stringify(doc);
      for (const id of [wf.id, steps(wf, 0), steps(wf, 1), planner.id, reviewer.id]) {
        expect(serialised).not.toContain(id);
      }
    });

    it("rebuilds the pipeline in another Workspace, re-pointing every reference at local rows", async () => {
      const { c } = await fixture(db, "acme");
      const wf = await shareable(c, [
        (await c.profile.agent.list({ limit: 50 })).items[0]?.id ?? "",
        (await c.profile.agent.list({ limit: 50 })).items[1]?.id ?? "",
      ]);
      const doc = await c.workflow.export({ id: wf.id });

      // A second Workspace with the same profile names and the same skill, but none of the ids.
      const other = await fixture(db, "beta");
      const localSkill = await other.c.library.skill.create({
        name: "impeccable",
        description: "Frontend design review.",
        source: { kind: "inline", body: "# impeccable" },
      });

      const imported = await other.c.workflow.import({ document: doc });

      expect(imported.workflow.name).toBe("Ship");
      expect(imported.workflow.steps.map((s) => s.name)).toEqual(["Implement", "Review"]);
      expect(imported.workflow.steps.map((s) => s.promptTemplate)).toEqual([
        "Build it.",
        "Review it.",
      ]);
      // The branch that pointed backwards points at the *imported* first Step, not the original.
      expect(imported.workflow.steps[1]?.branch?.thenStepId).toBe(
        imported.workflow.steps[0]?.id ?? "",
      );
      expect(imported.workflow.steps[0]?.skillIds).toEqual([localSkill.id]);
      // Beta has no `playwright` server, so the Step loses it — and is told so.
      expect(imported.workflow.steps[0]?.mcpServerIds).toEqual([]);
      expect(imported.unmatchedMcpServers).toEqual(["playwright"]);
      expect(imported.unmatchedHarnessProfiles).toEqual([]);
      // A freshly imported definition has been edited zero times.
      expect(imported.workflow.version).toBe(1);
    });

    it("substitutes a harness it does not have, and names the one it could not honour", async () => {
      const { c, planner, reviewer } = await fixture(db, "acme");
      const doc = await c.workflow.export({
        id: (await shareable(c, [planner.id, reviewer.id])).id,
      });
      const renamed = { ...doc, steps: doc.steps.map((s) => ({ ...s, harnessProfile: "Gemini" })) };

      const other = await fixture(db, "beta");
      const imported = await other.c.workflow.import({ document: renamed });

      expect(imported.unmatchedHarnessProfiles).toEqual(["Gemini"]);
      // Every Step still names a harness — a Step without one could not run at all.
      const local = (await other.c.profile.agent.list({ limit: 50 })).items.map((p) => p.id);
      for (const step of imported.workflow.steps) expect(local).toContain(step.agentProfileId);
    });

    it("puts every Step on the fallback the caller chose, when the document's names are unknown", async () => {
      const { c, planner, reviewer } = await fixture(db, "acme");
      const doc = await c.workflow.export({
        id: (await shareable(c, [planner.id, reviewer.id])).id,
      });
      const other = await fixture(db, "beta");
      const imported = await other.c.workflow.import({
        document: { ...doc, steps: doc.steps.map((s) => ({ ...s, harnessProfile: "Gemini" })) },
        fallbackHarnessProfileId: other.reviewer.id,
      });
      expect(imported.workflow.steps.map((s) => s.agentProfileId)).toEqual([
        other.reviewer.id,
        other.reviewer.id,
      ]);
    });

    it("refuses a fallback profile from another Workspace before anything is written", async () => {
      const { c, planner, reviewer } = await fixture(db, "acme");
      const doc = await c.workflow.export({
        id: (await shareable(c, [planner.id, reviewer.id])).id,
      });
      const other = await fixture(db, "beta");
      const before = (await other.c.workflow.list({})).length;

      expect(
        await errMessage(() =>
          other.c.workflow.import({ document: doc, fallbackHarnessProfileId: planner.id }),
        ),
      ).toBe(CommonErrorCode.NotFound);
      // Refused inside the transaction, so not even the Workflow row survives it.
      expect(await other.c.workflow.list({})).toHaveLength(before);
    });

    it("suffixes the name rather than colliding, so the same document imports twice", async () => {
      const { c, planner, reviewer } = await fixture(db, "acme");
      const doc = await c.workflow.export({
        id: (await shareable(c, [planner.id, reviewer.id])).id,
      });

      // Back into the Workspace it came from, where "Ship" is already taken.
      expect((await c.workflow.import({ document: doc })).workflow.name).toBe("Ship (2)");
      expect((await c.workflow.import({ document: doc })).workflow.name).toBe("Ship (3)");
      expect((await c.workflow.import({ document: doc, name: "Ours" })).workflow.name).toBe("Ours");
    });

    it("produces a pipeline a Task can actually be attached to — the graph rules still hold", async () => {
      const { c, planner, reviewer } = await fixture(db, "acme");
      const doc = await c.workflow.export({
        id: (await shareable(c, [planner.id, reviewer.id])).id,
      });
      const other = await fixture(db, "beta");
      const imported = await other.c.workflow.import({ document: doc });
      const t = await other.newTask("Wire the latch");

      const binding = await other.c.workflow.attachTask({
        taskId: t.id,
        workflowId: imported.workflow.id,
      });
      expect(binding.currentStep.name).toBe("Implement");
    });

    it("does not export another Workspace's workflow", async () => {
      const { c, planner, reviewer } = await fixture(db, "acme");
      const wf = await shareable(c, [planner.id, reviewer.id]);
      const other = await fixture(db, "beta");
      expect(await errCode(() => other.c.workflow.export({ id: wf.id }))).toBe("NOT_FOUND");
    });
  });

  describe("definition drift is a signal, not a latch", () => {
    it("does not bump the version for an edit that changes nothing", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      const step = wf.steps[2];
      if (!step) throw new Error("pipeline");

      // An empty patch, and a field set to the value it already holds. Neither is an edit.
      await c.workflow.updateStep({ stepId: step.id });
      await c.workflow.updateStep({ stepId: step.id, name: step.name, gate: step.gate });

      const after = await c.workflow.get({ id: wf.id });
      expect(after.version).toBe(wf.version);
      expect((await c.workflow.taskBinding({ taskId: t.id })).definitionDrifted).toBe(false);
    });

    it("lets an operator accept a drifted definition without restarting the pipeline", async () => {
      const { c, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship", "auto");
      const t = await newTask("Wire the latch");
      await c.workflow.attachTask({ taskId: t.id, workflowId: wf.id });
      await c.workflow.advanceTask({
        taskId: t.id,
        fromStepId: steps(wf, 0),
        signal: "agent-signal",
        producedChanges: false,
      });
      await c.workflow.updateStep({ stepId: steps(wf, 2), promptTemplate: "Review it twice." });
      expect((await c.workflow.taskBinding({ taskId: t.id })).definitionDrifted).toBe(true);

      const acknowledged = await c.workflow.acknowledgeDrift({ taskId: t.id });
      expect(acknowledged.definitionDrifted).toBe(false);
      // And the cursor is untouched: accepting the edit is not restarting the run.
      expect(acknowledged.currentStep.name).toBe("Implement");
    });

    it("refuses to acknowledge drift on a Task that follows no workflow", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const t = await newTask("Wire the latch");
      expect(await errMessage(() => c.workflow.acknowledgeDrift({ taskId: t.id }))).toBe(
        WorkflowErrorCode.TaskNotOnWorkflow,
      );
    });
  });

  describe("the external MCP surface", () => {
    it("exposes the authoring tools, and never the one that drives a Task's own gates", () => {
      // `advanceTask` is the call that opens a gate, and the holder of an MCP token may be the
      // harness the gate is for; the rest of the namespace is how an AI builds the pipeline it
      // will not itself be allowed to advance (spec F03).
      const workflowTools = listMcpTools()
        .map((tool) => tool.name)
        .filter((n) => n.startsWith("workflow_"));
      expect(workflowTools).toContain("workflow_create");
      expect(workflowTools).toContain("workflow_addStep");
      expect(workflowTools).toContain("workflow_authoringGuide");
      expect(findMcpTool("workflow_advanceTask")).toBeUndefined();
      expect(findMcpTool("workflow_acknowledgeDrift")).toBeUndefined();
    });
  });

  describe("the kill switch", () => {
    it("refuses every workflow procedure when ff-workflows is off", async () => {
      const { wsId, planner, newTask, newPipeline } = await fixture(db, "acme");
      const wf = await newPipeline("Ship");
      const t = await newTask("Wire the latch");
      const step = wf.steps[0];
      if (!step) throw new Error("pipeline");
      const off = caller(db, wsId, { "ff-workflows": false });

      const calls: Array<() => Promise<unknown>> = [
        () => off.workflow.list({}),
        () => off.workflow.get({ id: wf.id }),
        () => off.workflow.create({ name: "Nope" }),
        () => off.workflow.rename({ id: wf.id, name: "Nope" }),
        () => off.workflow.delete({ id: wf.id }),
        () => off.workflow.addStep({ workflowId: wf.id, name: "Nope", agentProfileId: planner.id }),
        () => off.workflow.updateStep({ stepId: step.id, name: "Nope" }),
        () => off.workflow.reorderStep({ stepId: step.id, afterStepId: null, beforeStepId: null }),
        () => off.workflow.deleteStep({ stepId: step.id }),
        () => off.workflow.attachTask({ taskId: t.id, workflowId: wf.id }),
        () => off.workflow.detachTask({ taskId: t.id }),
        () => off.workflow.taskBinding({ taskId: t.id }),
        () => off.workflow.acknowledgeDrift({ taskId: t.id }),
        () =>
          off.workflow.advanceTask({
            taskId: t.id,
            fromStepId: step.id,
            signal: "review",
            producedChanges: false,
          }),
      ];
      for (const call of calls) {
        expect(await errCode(call)).toBe("FORBIDDEN");
        expect(await errMessage(call)).toBe(CommonErrorCode.FlagDisabled);
      }
    });

    it("refuses them when the core program itself is off, flag or no flag", async () => {
      const { wsId } = await fixture(db, "acme");
      const off = caller(db, wsId, { "ff-core-program": false });
      expect(await errMessage(() => off.workflow.list({}))).toBe(CommonErrorCode.FlagDisabled);
    });
  });

  describe("the Workflow store", () => {
    it("lists the catalog with the Steps each entry has and the Skills it brings", async () => {
      const { c } = await fixture(db, "acme");
      const store = await c.workflow.store({});
      const speckit = store.find((e) => e.id === "speckit-sdd");
      expect(speckit?.steps[0]).toBe("Specify");
      expect(speckit?.skills).toContain("speckit-specify");
    });

    it("installs an entry onto the chosen profile, adding its Skills to the library switched off", async () => {
      const { c, reviewer } = await fixture(db, "acme");
      const installed = await c.workflow.installFromStore({
        entryId: "security-review",
        harnessProfileId: reviewer.id,
      });
      expect(installed.createdSkills).toEqual(["security-review-checklist"]);
      expect(installed.reusedSkills).toEqual([]);
      expect(installed.workflow.name).toBe("Security review");
      expect(installed.workflow.steps.map((s) => s.agentProfileId)).toEqual([
        reviewer.id,
        reviewer.id,
        reviewer.id,
      ]);

      const skills = await c.library.skill.list({});
      const checklist = skills.find((s) => s.name === "security-review-checklist");
      expect(checklist?.enabled).toBe(false);
      // Every Step of the entry names the Skill, and every one of them is bound to the row.
      expect(installed.workflow.steps.every((s) => s.skillIds.includes(checklist?.id ?? ""))).toBe(
        true,
      );
      // The branch survived the trip: the re-audit loops back to the fix.
      const reaudit = installed.workflow.steps[2];
      expect(reaudit?.branch?.thenStepId).toBe(steps(installed.workflow, 1));
      expect(reaudit?.branch?.elseStepId).toBeNull();
    });

    it("keeps a Skill the library already holds by name — the upstream one wins over the bundled text", async () => {
      const { c, implementer } = await fixture(db, "acme");
      const upstream = await c.library.skill.create({
        name: "test-driven-development",
        description: "The real one, imported from the plugin repository.",
        source: { kind: "path", path: "/srv/skills/superpowers/skills/test-driven-development" },
      });
      const installed = await c.workflow.installFromStore({
        entryId: "superpowers-debugging",
        harnessProfileId: implementer.id,
      });
      expect(installed.reusedSkills).toEqual(["test-driven-development"]);
      expect(installed.createdSkills).toEqual([
        "systematic-debugging",
        "verification-before-completion",
      ]);
      const fix = installed.workflow.steps[1];
      expect(fix?.skillIds).toContain(upstream.id);
      const kept = (await c.library.skill.list({})).find(
        (s) => s.name === "test-driven-development",
      );
      expect(kept?.source).toEqual({
        kind: "path",
        path: "/srv/skills/superpowers/skills/test-driven-development",
      });
    });

    it("installs the same entry twice under a suffixed name, creating no second Skill", async () => {
      const { c, planner } = await fixture(db, "acme");
      const first = await c.workflow.installFromStore({
        entryId: "speckit-sdd",
        harnessProfileId: planner.id,
      });
      const second = await c.workflow.installFromStore({
        entryId: "speckit-sdd",
        harnessProfileId: planner.id,
      });
      expect(first.createdSkills.length).toBe(7);
      expect(second.createdSkills).toEqual([]);
      expect(second.reusedSkills.length).toBe(7);
      expect(second.workflow.name).toBe(`${first.workflow.name} (2)`);
      const named = await c.workflow.installFromStore({
        entryId: "speckit-sdd",
        harnessProfileId: planner.id,
        name: "SDD for the API",
      });
      expect(named.workflow.name).toBe("SDD for the API");
    });

    it("writes the vendored text — description and body, byte for byte — into each Skill it creates", async () => {
      const { c, planner } = await fixture(db, "acme");
      const installed = await c.workflow.installFromStore({
        entryId: "openspec-change",
        harnessProfileId: planner.id,
      });
      const skills = await c.library.skill.list({});
      for (const name of installed.createdSkills) {
        const row = skills.find((s) => s.name === name);
        const vendored = VENDORED_STORE.skills[name];
        if (!vendored) throw new Error(`${name} is not vendored`);
        expect(row?.description).toBe(vendored.description);
        expect(row?.source).toEqual({ kind: "inline", body: vendored.body });
        expect(row?.enabled).toBe(false);
      }
      // Upstream text, not a summary of it: OpenSpec's own words are in the library.
      expect(skills.find((s) => s.name === "openspec-propose")?.source).toMatchObject({
        body: expect.stringContaining("openspec"),
      });
    });

    it("installs the entry exactly as the catalog's document says — gates, postures, prompts, branches — for every entry", async () => {
      const { c, planner } = await fixture(db, "acme");
      for (const entry of WORKFLOW_STORE) {
        const installed = await c.workflow.installFromStore({
          entryId: entry.id,
          harnessProfileId: planner.id,
        });
        const document = workflowStoreDocument(entry, "Opus");
        const exported = await c.workflow.export({ id: installed.workflow.id });
        // The name may be suffixed (the seeds are already there); everything else round-trips.
        expect({ ...exported, name: document.name }).toEqual(document);
      }
    });

    it("is withheld with the rest of the namespace when workflows are off", async () => {
      const { c, planner, wsId } = await fixture(db, "acme");
      const off = caller(db, wsId, { "ff-workflows": false });
      expect(await errMessage(() => off.workflow.store({}))).toBe(CommonErrorCode.FlagDisabled);
      expect(
        await errMessage(() =>
          off.workflow.installFromStore({ entryId: "hotfix", harnessProfileId: planner.id }),
        ),
      ).toBe(CommonErrorCode.FlagDisabled);
      expect((await c.workflow.list({})).map((w) => w.name)).not.toContain("Hotfix");
    });

    it("refuses an unknown entry, and another Workspace's profile, before writing anything", async () => {
      const { c, planner } = await fixture(db, "acme");
      const other = await fixture(db, "beta");
      expect(
        await errMessage(() =>
          c.workflow.installFromStore({ entryId: "no-such-entry", harnessProfileId: planner.id }),
        ),
      ).toBe(CommonErrorCode.NotFound);
      expect(
        await errMessage(() =>
          other.c.workflow.installFromStore({ entryId: "hotfix", harnessProfileId: planner.id }),
        ),
      ).toBe(CommonErrorCode.NotFound);
      // The defaults seeded with the profile are there; the store entry is not.
      expect((await other.c.workflow.list({})).map((w) => w.name)).not.toContain("Hotfix");
      expect((await other.c.library.skill.list({})).map((s) => s.name)).not.toContain(
        "security-review-checklist",
      );
    });
  });
});
