/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  ensureDefaultHarnessCatalog,
  issue as issueTable,
  sessionEvent,
  session as sessionTable,
  task as taskTable,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, eq } from "drizzle-orm";
import { resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * Sub-tasks and session forking (issue #56), against a real in-memory SQLite database so the
 * self-referencing foreign key, the inheritance and the delete cascade are exercised rather than
 * described.
 *
 * The graph reasoning — cycles, subtrees — is unit-tested in `@solow/core`, and what a launched
 * sub-task is briefed with is proved against the run loop in the orchestrator. What is proved
 * here is the behaviour those exist to protect: a child that carries its parent's setup and a
 * point in its transcript, its own worktree branch, a parent that is not touched by any of it
 * (AC-4), and a subtree that goes to History — and comes back — as one.
 */

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true, "ff-workflows": true },
  };
}

const caller = (db: TestDb, workspaceId: string) => appRouter.createCaller(ctx(db, workspaceId));

/** Run a call and return the TRPCError code, or "OK" if it resolved. */
async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

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
  const harness = await c.profile.agent.create({
    name: "Claude",
    agentCatalogId,
    authMode: "subscription",
    secretId: secret.id,
    concurrencyCap: 3,
  });
  const other = await c.profile.agent.create({
    name: "Reviewer",
    agentCatalogId,
    authMode: "subscription",
    secretId: secret.id,
    concurrencyCap: 3,
  });
  const executor = await c.profile.executor.create({ name: "Local" });
  const otherExecutor = await c.profile.executor.create({ name: "Second" });
  const repo = await c.repository.connect({
    name: "repo",
    source: "local_path",
    location: `/srv/${name}`,
  });
  const otherRepo = await c.repository.connect({
    name: "docs",
    source: "local_path",
    location: `/srv/${name}-docs`,
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
      agentProfileId: harness.id,
      executorProfileId: executor.id,
      repositories: [{ repositoryId: repo.id, baseRef: "main" }],
    });

  /** A finished run on `taskId` with `count` recorded turns — a transcript to fork from. */
  const transcript = async (taskId: string, count = 3) => {
    const [session] = await db
      .insert(sessionTable)
      .values({ workspaceId: wsId, taskId, state: "awaiting_review" })
      .returning();
    if (!session) throw new Error("failed to seed session");
    for (let seq = 0; seq < count; seq++) {
      await db.insert(sessionEvent).values({
        workspaceId: wsId,
        sessionId: session.id,
        seq,
        kind: "assistant_turn",
        payload: { kind: "assistant_turn", text: `line ${seq}`, thinking: false },
      });
    }
    return session.id;
  };

  return {
    wsId,
    c,
    harness,
    other,
    executor,
    otherExecutor,
    repo,
    otherRepo,
    issue,
    newTask,
    transcript,
  };
}

describe("sub-tasks (issue #56)", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 5).toString("base64");
    process.env.SOLOW_STREAM_SECRET ??= "test-stream-secret";
    process.env.SOLOW_AUTH_SECRET ??= "test-auth-secret";
    process.env.SOLOW_DEV_OWNER ??= "on";
  });

  beforeEach(() => {
    db = createTestDb();
    resetRateLimits();
  });

  describe("AC-1 — a Task may have child Tasks in the same Workspace", () => {
    it("creates a sub-task under its parent, in the backlog", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Rewire the latch");

      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Order a servo" });

      expect(child.parentTaskId).toBe(parent.id);
      expect(child.state).toBe("backlog");
      // Not overridable: a sub-task under a different Issue is a new Task with a misleading
      // breadcrumb, not a split.
      expect(child.issueId).toBe(parent.issueId);
    });

    it("lists a Task's children, and the top-level Tasks, from the same procedure", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      await newTask("Unrelated");
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });

      const children = await c.task.list({ parentTaskId: parent.id });
      expect(children.items.map((t) => t.id)).toEqual([child.id]);

      const roots = await c.task.list({ parentTaskId: null });
      expect(roots.items.map((t) => t.title).sort()).toEqual(["Parent", "Unrelated"]);
    });

    it("nests a sub-task under a sub-task", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      const grandchild = await c.task.createSubtask({
        parentTaskId: child.id,
        title: "Grandchild",
      });

      expect(grandchild.parentTaskId).toBe(child.id);
    });

    it("refuses a parent in another Workspace (Principle V)", async () => {
      const mine = await fixture(db, "acme");
      const theirs = await fixture(db, "globex");
      const parent = await theirs.newTask("Theirs");

      expect(
        await errCode(() => mine.c.task.createSubtask({ parentTaskId: parent.id, title: "Mine" })),
      ).toBe("NOT_FOUND");
    });
  });

  describe("AC-2 — inheritance, and what overrides it", () => {
    it("inherits the parent's Harness Profile, Executor Profile and Repositories", async () => {
      const { c, newTask, harness, executor, repo } = await fixture(db, "acme");
      const parent = await newTask("Parent");

      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });

      expect(child.agentProfileId).toBe(harness.id);
      expect(child.executorProfileId).toBe(executor.id);
      expect(child.repositories).toHaveLength(1);
      expect(child.repositories[0]?.repositoryId).toBe(repo.id);
      // The base ref is part of the setup, so it is inherited with the attachment.
      expect(child.repositories[0]?.baseRef).toBe("main");
    });

    it("takes each override the Owner states, and inherits the rest", async () => {
      const { c, newTask, executor, other, otherRepo } = await fixture(db, "acme");
      const parent = await newTask("Parent");

      const child = await c.task.createSubtask({
        parentTaskId: parent.id,
        title: "Child",
        agentProfileId: other.id,
        repositories: [{ repositoryId: otherRepo.id }],
      });

      expect(child.agentProfileId).toBe(other.id);
      expect(child.executorProfileId).toBe(executor.id);
      expect(child.repositories.map((r) => r.repositoryId)).toEqual([otherRepo.id]);
    });

    it("refuses an override that names another Workspace's Profile", async () => {
      const mine = await fixture(db, "acme");
      const theirs = await fixture(db, "globex");
      const parent = await mine.newTask("Parent");

      expect(
        await errCode(() =>
          mine.c.task.createSubtask({
            parentTaskId: parent.id,
            title: "Child",
            agentProfileId: theirs.harness.id,
          }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("inherits the parent's Workflow, at its first Step rather than the parent's cursor", async () => {
      const { c, newTask, harness } = await fixture(db, "acme");
      const wf = await c.workflow.create({ name: "Plan then build" });
      for (const name of ["Plan", "Build"]) {
        await c.workflow.addStep({
          workflowId: wf.id,
          name,
          agentProfileId: harness.id,
          promptTemplate: `${name} it.`,
          gate: "auto",
          advanceOn: "agent-signal",
        });
      }
      const pipeline = await c.workflow.get({ id: wf.id });
      const parent = await newTask("Parent");
      await c.workflow.attachTask({ taskId: parent.id, workflowId: wf.id });

      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });

      expect(child.workflowId).toBe(wf.id);
      expect(child.workflowStepId).toBe(pipeline.steps[0]?.id ?? null);
    });

    it("creates the sub-task on no Workflow when the parent's has no Steps to enter", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const empty = await c.workflow.create({ name: "Empty" });
      // Attaching an empty Workflow is refused, so the parent is pointed at one directly — the
      // state a Workflow edited down to nothing under a running Task leaves behind.
      await db.update(taskTable).set({ workflowId: empty.id }).where(eq(taskTable.id, parent.id));

      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      expect(child.workflowId).toBeNull();
      expect(child.workflowStepId).toBeNull();
    });
  });

  describe("AC-3 — starting from a fork point in the parent's transcript", () => {
    it("forks from the head of the parent's latest Session by default", async () => {
      const { c, newTask, transcript } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const sessionId = await transcript(parent.id, 3);

      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });

      expect(child.forkedFrom?.sessionId).toBe(sessionId);
      expect(child.forkedFrom?.seq).toBe(2);
      expect(child.forkedFrom?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("forks from the point the Owner named", async () => {
      const { c, newTask, transcript } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      await transcript(parent.id, 5);

      const child = await c.task.createSubtask({
        parentTaskId: parent.id,
        title: "Child",
        forkSeq: 1,
      });

      expect(child.forkedFrom?.seq).toBe(1);
    });

    it("refuses a fork point the parent's log does not have, rather than starting cold", async () => {
      const { c, newTask, transcript } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      await transcript(parent.id, 2);

      expect(
        await errCode(() =>
          c.task.createSubtask({ parentTaskId: parent.id, title: "Child", forkSeq: 99 }),
        ),
      ).toBe("NOT_FOUND");
    });

    it("starts cold when the parent has never run", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");

      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      expect(child.forkedFrom).toBeNull();
    });

    it("starts cold when the Owner asks for it, even with a transcript to fork", async () => {
      const { c, newTask, transcript } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      await transcript(parent.id, 3);

      const child = await c.task.createSubtask({
        parentTaskId: parent.id,
        title: "Child",
        fork: false,
      });
      expect(child.forkedFrom).toBeNull();
    });
  });

  describe("AC-4 — the fork is a read of the parent, never a mutation", () => {
    it("leaves the parent's row, Session and transcript exactly as they were", async () => {
      const { c, wsId, newTask, transcript } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const sessionId = await transcript(parent.id, 4);

      const before = await c.task.get({ id: parent.id });
      const [sessionBefore] = await db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.id, sessionId));
      const eventsBefore = await db
        .select()
        .from(sessionEvent)
        .where(and(eq(sessionEvent.workspaceId, wsId), eq(sessionEvent.sessionId, sessionId)));

      await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });

      expect(await c.task.get({ id: parent.id })).toEqual(before);
      const [sessionAfter] = await db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.id, sessionId));
      expect(sessionAfter).toEqual(sessionBefore);
      const eventsAfter = await db
        .select()
        .from(sessionEvent)
        .where(and(eq(sessionEvent.workspaceId, wsId), eq(sessionEvent.sessionId, sessionId)));
      expect(eventsAfter).toEqual(eventsBefore);
      // No second Session on the parent either: forking reads a transcript, it does not open one.
      const sessions = await db
        .select()
        .from(sessionTable)
        .where(and(eq(sessionTable.workspaceId, wsId), eq(sessionTable.taskId, parent.id)));
      expect(sessions).toHaveLength(1);
    });
  });

  describe("AC-5 — each sub-task runs in its own worktree", () => {
    it("gives the child its own checkout branch, never the parent's", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");

      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });

      expect(child.repositories[0]?.checkoutBranch).toBe(`solow/task-${child.id}`);
      expect(child.repositories[0]?.checkoutBranch).not.toBe(
        parent.repositories[0]?.checkoutBranch,
      );
    });
  });

  describe("AC-6 — a parent relationship that would close a chain is refused", () => {
    it("moves a Task under another, and detaches it again", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");
      const b = await newTask("B");

      expect((await c.task.setParent({ id: b.id, parentTaskId: a.id })).parentTaskId).toBe(a.id);
      expect((await c.task.setParent({ id: b.id, parentTaskId: null })).parentTaskId).toBeNull();
    });

    it("refuses a Task as its own parent", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const a = await newTask("A");

      expect(await errCode(() => c.task.setParent({ id: a.id, parentTaskId: a.id }))).toBe(
        "BAD_REQUEST",
      );
    });

    it("refuses a move under a Task's own descendant, and names the chain", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      const grandchild = await c.task.createSubtask({ parentTaskId: child.id, title: "Grand" });

      let message = "OK";
      try {
        await c.task.setParent({ id: parent.id, parentTaskId: grandchild.id });
      } catch (e) {
        message = (e as { message?: string }).message ?? "";
      }
      expect(message).toContain("TASK_PARENT_CYCLE");
      expect(message).toContain(parent.id);
      // The chain is left exactly as it was.
      expect((await c.task.get({ id: parent.id })).parentTaskId).toBeNull();
    });
  });

  describe("AC-6 — the parent link stays inside one Issue and one Workspace", () => {
    it("refuses a parent from another Workspace (Principle V)", async () => {
      const mine = await fixture(db, "acme");
      const theirs = await fixture(db, "globex");
      const a = await mine.newTask("Mine");
      const b = await theirs.newTask("Theirs");

      expect(await errCode(() => mine.c.task.setParent({ id: a.id, parentTaskId: b.id }))).toBe(
        "NOT_FOUND",
      );
    });

    it("refuses a parent on another Issue", async () => {
      const { c, wsId, newTask, harness, executor, repo } = await fixture(db, "acme");
      const a = await newTask("A");
      const [otherIssue] = await db
        .insert(issueTable)
        .values({ workspaceId: wsId, title: "Another issue" })
        .returning();
      if (!otherIssue) throw new Error("failed to seed issue");
      const elsewhere = await c.task.create({
        issueId: otherIssue.id,
        title: "Elsewhere",
        agentProfileId: harness.id,
        executorProfileId: executor.id,
        repositories: [{ repositoryId: repo.id }],
      });

      expect(await errCode(() => c.task.setParent({ id: a.id, parentTaskId: elsewhere.id }))).toBe(
        "BAD_REQUEST",
      );
      expect((await c.task.get({ id: a.id })).parentTaskId).toBeNull();
    });

    it("refuses to split a Task that is in History", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      await c.task.delete({ id: parent.id });

      expect(
        await errCode(() => c.task.createSubtask({ parentTaskId: parent.id, title: "Child" })),
      ).toBe("NOT_FOUND");
    });
  });

  describe("deleting a parent", () => {
    it("reports the live descendants the delete would take with it", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      await c.task.createSubtask({ parentTaskId: child.id, title: "Grand" });

      const impact = await c.task.deletionImpact({ id: parent.id });
      expect(impact.subtaskCount).toBe(2);
    });

    it("sends the whole subtree to History, not just the Task named", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      const grandchild = await c.task.createSubtask({ parentTaskId: child.id, title: "Grand" });
      const bystander = await newTask("Bystander");

      await c.task.delete({ id: parent.id });

      expect(await errCode(() => c.task.get({ id: child.id }))).toBe("NOT_FOUND");
      expect(await errCode(() => c.task.get({ id: grandchild.id }))).toBe("NOT_FOUND");
      // In History, not gone: the rows stay restorable for the retention window.
      const inHistory = await c.task.get({ id: grandchild.id, includeDeleted: true });
      expect(inHistory.deletedAt).not.toBeNull();
      expect((await c.task.get({ id: bystander.id })).id).toBe(bystander.id);
    });

    it("refuses while a sub-task is still running, rather than orphaning its harness", async () => {
      const { c, wsId, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      await db
        .insert(sessionTable)
        .values({ workspaceId: wsId, taskId: child.id, state: "active" });

      expect(await errCode(() => c.task.delete({ id: parent.id }))).not.toBe("OK");
      expect((await c.task.get({ id: child.id })).id).toBe(child.id);
      expect((await c.task.get({ id: parent.id })).id).toBe(parent.id);
    });

    it("is not held back by a dependency edge from inside its own subtree", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      // The child waits for its parent — an edge that is going with the delete, so it gates
      // nothing. Refusing on it would make every such parent undeletable without `force`.
      await c.task.addDependency({ taskId: child.id, blockedByTaskId: parent.id });

      expect(await errCode(() => c.task.delete({ id: parent.id }))).toBe("OK");
    });
  });

  describe("restoring from History", () => {
    it("brings back the sub-tasks that left with it", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      await c.task.delete({ id: parent.id });

      await c.task.restore({ id: parent.id });

      const back = await c.task.get({ id: child.id });
      expect(back.deletedAt).toBeNull();
      expect(back.parentTaskId).toBe(parent.id);
    });

    it("leaves in History a sub-task that had been deleted on its own before", async () => {
      const { c, newTask } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      const early = await c.task.createSubtask({ parentTaskId: parent.id, title: "Early" });
      await c.task.delete({ id: early.id });
      // A distinct timestamp for the second delete: `deletedAt` is what tells the two apart.
      await new Promise((resolve) => setTimeout(resolve, 5));
      await c.task.delete({ id: parent.id });

      await c.task.restore({ id: parent.id });

      expect(await errCode(() => c.task.get({ id: early.id }))).toBe("NOT_FOUND");
    });

    it("detaches a sub-task restored while its parent stays in History", async () => {
      const { c, newTask, transcript } = await fixture(db, "acme");
      const parent = await newTask("Parent");
      await transcript(parent.id, 2);
      const child = await c.task.createSubtask({ parentTaskId: parent.id, title: "Child" });
      await c.task.delete({ id: parent.id });

      const back = await c.task.restore({ id: child.id });

      expect(back.parentTaskId).toBeNull();
      // Where it started is still true: the fork point outlives the parent link.
      expect(back.forkedFrom).toEqual(child.forkedFrom);
    });
  });
});
