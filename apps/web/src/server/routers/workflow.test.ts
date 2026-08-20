/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { CommonErrorCode, WorkflowErrorCode } from "@gatecontrol/contracts";
import {
  ensureDefaultAgentCatalog,
  issue as issueTable,
  review as reviewTable,
  sessionEvent as sessionEventTable,
  session as sessionTable,
  task as taskTable,
  workspace,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import { findMcpTool, listMcpTools } from "../mcp/tools.js";
import { resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * Workflow integration tests (issue #5) against a real in-memory SQLite database, so the two
 * tables, the unique rank index and the Workspace scoping are exercised rather than described.
 *
 * The ordering and advance rules themselves are unit-tested in `@gatecontrol/core`. What is
 * proved here is that the router reaches for them before writing, that the durable cursor is
 * what a later read actually gets back, and that the last Step cannot be finished without a
 * `review` row no matter how the Steps are configured (Principle I).
 */

function ctx(db: TestDb, workspaceId: string, flags?: Partial<BaseContext["flagOverrides"]>) {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true, "ff-workflows": true, ...flags },
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
  const agentCatalogId = await ensureDefaultAgentCatalog(db, wsId);
  const secret = await c.secret.set({ name: "sub", kind: "subscription_token", value: "tok" });

  const agent = async (profileName: string) =>
    await c.profile.agent.create({
      name: profileName,
      agentCatalogId,
      authMode: "subscription",
      secretId: secret.id,
      concurrencyCap: 3,
    });
  const planner = await agent("Opus");
  const implementer = await agent("Copilot");
  const reviewer = await agent("Codex");

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
   * The kandev pipeline the issue is written around: one agent plans, another implements, a
   * third reviews — three Steps, three different Agent Profiles, one Workflow.
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
    .values({ workspaceId: wsId, taskId, state: "awaiting_review", diffRef: "gatecontrol/task" })
    .returning();
  if (!s) throw new Error("failed to seed session");
  await db.insert(sessionEventTable).values({
    workspaceId: wsId,
    sessionId: s.id,
    seq: 1,
    kind: "diff",
    payload: {
      kind: "diff",
      diffRef: "gatecontrol/task",
      files: [{ path: "latch.ts", status: "modified", additions: 3, deletions: 1 }],
      patch: "",
      truncated: false,
    },
  });
}

describe("workflows", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
    process.env.GATECONTROL_STREAM_SECRET ??= "test-stream-secret";
    process.env.GATECONTROL_AUTH_SECRET ??= "test-auth-secret";
    process.env.GATECONTROL_DEV_OWNER ??= "on";
  });

  beforeEach(() => {
    db = createTestDb();
    resetRateLimits();
  });

  describe("AC-1 — designing a workflow of ordered steps", () => {
    it("lists steps in the order they were added, each with its own agent profile", async () => {
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
      // AC-3, expressed in the model: one Task, three Steps, three different agents.
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

      expect(await other.c.workflow.list({})).toHaveLength(0);
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

    it("refuses a step naming another Workspace's agent profile before any row is written", async () => {
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

    it("refuses to attach a workflow to a task whose agent is already running", async () => {
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
      expect(await c.workflow.list({})).toHaveLength(0);
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

    it("keeps the agent's handoff when the gate holds, so the replay that moves the cursor still carries it", async () => {
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

      // Whatever notices the decision replays the agent's signal, and it does not have the
      // agent's words — the server kept them.
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
    it("exposes no workflow tool, so a token cannot drive a Task's own gates", () => {
      // The namespace is withheld by decision rather than admitted by omission: `advanceTask` is
      // the call that opens a gate, and the holder of an MCP token is the agent the gate is for.
      expect(listMcpTools().filter((tool) => tool.name.startsWith("workflow_"))).toEqual([]);
      expect(findMcpTool("workflow_advanceTask")).toBeUndefined();
      expect(findMcpTool("workflow_delete")).toBeUndefined();
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
});
