/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { CommonErrorCode, TaskErrorCode } from "@solow/contracts";
import { TASK_RETENTION_MS } from "@solow/core";
import { session, taskDependency, task as taskTable, worktree } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { getIssueById } from "./issue.js";
import {
  activeSessionForTask,
  addTaskDependencyEdge,
  createTaskRecord,
  deleteTask,
  getTaskById,
  listDeletedTasks,
  listTasks,
  restoreTask,
  taskDeletionImpact,
} from "./task.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Deleting a single Task (board card + Task page). The cascade itself is shared with
 * `deleteIssue` via `task-cascade.ts`; what is proved here is the two guards that are specific
 * to deleting one Task — a running harness, and Tasks blocked by this one.
 */

describe("deleteTask", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  async function seed(name: string) {
    const g = await seedWorkspaceGraph(db, name);
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssue(db, g.workspaceId, { title: `${name} issue` });
    const make = async (title: string, state: "backlog" | "running" | "failed" = "backlog") => {
      const made = await createTaskRecord(ctx, {
        issueId: issue.id,
        title,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositories: [{ repositoryId: g.repositoryId }],
        state,
      });
      if (!made.ok) throw new Error("task seed failed");
      return made.data;
    };
    return { g, ctx, issue, make };
  }

  it("moves the Task to History with its sessions and worktree records intact, leaving the Issue in place", async () => {
    // A delete is a mark now (F02 FR-10): the record survives the retention window so the Task
    // can be restored and its Sessions read; the orchestrator's retention sweep is what cascades.
    const { g, ctx, issue, make } = await seed("delete-task");
    const t = await make("Gave up on this", "failed");
    await db.insert(session).values({ workspaceId: g.workspaceId, taskId: t.id, state: "closed" });
    await db.insert(worktree).values({
      workspaceId: g.workspaceId,
      taskId: t.id,
      repositoryId: g.repositoryId,
      path: ".solow/worktrees/x",
      branch: "solow/x",
      status: "active",
    });

    expect(await deleteTask(ctx, { id: t.id, force: false })).toEqual({
      ok: true,
      data: { id: t.id },
    });
    const [row] = await db.select().from(taskTable).where(eq(taskTable.id, t.id));
    expect(row?.deletedAt).toBeTruthy();
    expect(await db.select().from(session).where(eq(session.taskId, t.id))).toHaveLength(1);
    expect(await db.select().from(worktree).where(eq(worktree.taskId, t.id))).toHaveLength(1);
    // Invisible to every reader of live Tasks, visible to the one that asks for History.
    expect(await getTaskById(ctx, t.id)).toEqual({ ok: false, error: CommonErrorCode.NotFound });
    expect(await listTasks(ctx, { limit: 50 })).toMatchObject({ ok: true, data: { items: [] } });
    expect(await getTaskById(ctx, t.id, { includeDeleted: true })).toMatchObject({
      ok: true,
      data: { id: t.id, deletedAt: row?.deletedAt },
    });
    expect((await listDeletedTasks(ctx)).ok && (await listDeletedTasks(ctx))).toMatchObject({
      ok: true,
      data: [{ id: t.id }],
    });
    // An Issue with no Tasks is an ordinary state — it is how every Issue starts.
    expect(await getIssueById(ctx, issue.id)).toMatchObject({ ok: true });
  });

  it("restores a deleted Task inside the retention window, and refuses past it", async () => {
    const { ctx, make } = await seed("restore-task");
    const t = await make("Deleted by mistake", "failed");
    expect(await restoreTask(ctx, t.id)).toEqual({ ok: false, error: TaskErrorCode.NotDeleted });

    await deleteTask(ctx, { id: t.id, force: false });
    expect(await restoreTask(ctx, t.id)).toMatchObject({
      ok: true,
      data: { id: t.id, state: "failed", deletedAt: null },
    });
    expect(await getTaskById(ctx, t.id)).toMatchObject({ ok: true });

    // Deleted eight days ago: the sweep may already have purged it, and a restore that raced it
    // would resurrect a Task with no Sessions.
    await deleteTask(ctx, { id: t.id, force: false });
    const stale = new Date(Date.now() - (TASK_RETENTION_MS + 60_000)).toISOString();
    await db.update(taskTable).set({ deletedAt: stale }).where(eq(taskTable.id, t.id));
    expect(await restoreTask(ctx, t.id)).toEqual({
      ok: false,
      error: TaskErrorCode.RetentionExpired,
    });
    expect(await listDeletedTasks(ctx)).toEqual({ ok: true, data: [] });
  });

  it("refuses while an active Session is on the Task, whatever its own state says", async () => {
    const { g, ctx, make } = await seed("delete-task-active-session");
    const t = await make("Says failed, session says otherwise", "failed");
    await db.insert(session).values({ workspaceId: g.workspaceId, taskId: t.id, state: "active" });

    expect(await deleteTask(ctx, { id: t.id, force: true })).toEqual({
      ok: false,
      error: TaskErrorCode.StillRunning,
    });
    expect(await activeSessionForTask(ctx, t.id)).toBeDefined();
  });

  it("proceeds once the caller has issued a stop, because cancellation is asynchronous", async () => {
    const { g, ctx, make } = await seed("delete-task-stop-issued");
    const t = await make("Being cancelled", "running");
    await db.insert(session).values({ workspaceId: g.workspaceId, taskId: t.id, state: "active" });

    // The row still reads `running` — it always will at this point, since Inngest cancels
    // between steps. Waiting for it to clear is what made a dead run undeletable.
    expect(await deleteTask(ctx, { id: t.id, force: true }, { stopIssued: true })).toMatchObject({
      ok: true,
    });
    expect(await getTaskById(ctx, t.id)).toEqual({ ok: false, error: CommonErrorCode.NotFound });
  });

  it("deletes a Task stuck in `running` with no Session left to stop", async () => {
    // The wreckage a run that died without reconciling leaves behind: the state says running,
    // nothing will ever update it again, and it holds the Harness Profile's concurrency slot.
    // Keying the guard on `task.state` made this permanently undeletable from the UI.
    const { ctx, make } = await seed("delete-task-stale-running");
    const t = await make("Its run died two days ago", "running");

    expect(await deleteTask(ctx, { id: t.id, force: false })).toEqual({
      ok: true,
      data: { id: t.id },
    });
    expect(await getTaskById(ctx, t.id)).toEqual({ ok: false, error: CommonErrorCode.NotFound });
  });

  it("refuses without force while another Task is blocked by this one", async () => {
    const { ctx, make } = await seed("delete-task-dependents");
    const blocker = await make("Blocks the other one");
    const waiter = await make("Waiting on it");
    const edge = await addTaskDependencyEdge(ctx, {
      taskId: waiter.id,
      blockedByTaskId: blocker.id,
    });
    if (!edge.ok) throw new Error("edge seed failed");

    expect(await deleteTask(ctx, { id: blocker.id, force: false })).toEqual({
      ok: false,
      error: TaskErrorCode.HasDependents,
    });
    expect(await db.select().from(taskTable).where(eq(taskTable.id, blocker.id))).toHaveLength(1);
  });

  it("with force, drops the edges and unblocks the waiting Task", async () => {
    const { ctx, make } = await seed("delete-task-force");
    const blocker = await make("Blocks the other one");
    const waiter = await make("Waiting on it");
    const edge = await addTaskDependencyEdge(ctx, {
      taskId: waiter.id,
      blockedByTaskId: blocker.id,
    });
    if (!edge.ok) throw new Error("edge seed failed");

    expect(await deleteTask(ctx, { id: blocker.id, force: true })).toMatchObject({ ok: true });

    // The waiter survives, and carries no edge pointing at a row that is gone.
    expect(await db.select().from(taskTable).where(eq(taskTable.id, waiter.id))).toHaveLength(1);
    expect(
      await db.select().from(taskDependency).where(eq(taskDependency.taskId, waiter.id)),
    ).toHaveLength(0);
  });

  it("cannot delete a Task in another Workspace (Principle V)", async () => {
    const { make } = await seed("delete-task-a");
    const other = await seedWorkspaceGraph(db, "delete-task-b");
    const t = await make("A's task");

    expect(await deleteTask(ctxFor(db, other.workspaceId), { id: t.id, force: true })).toEqual({
      ok: false,
      error: CommonErrorCode.NotFound,
    });
    expect(await db.select().from(taskTable).where(eq(taskTable.id, t.id))).toHaveLength(1);
  });

  it("reports the impact the confirmation states, counting only worktrees still on disk", async () => {
    const { g, ctx, make } = await seed("delete-task-impact");
    const blocker = await make("Blocks", "running");
    const waiter = await make("Waits");
    const edge = await addTaskDependencyEdge(ctx, {
      taskId: waiter.id,
      blockedByTaskId: blocker.id,
    });
    if (!edge.ok) throw new Error("edge seed failed");
    await db
      .insert(session)
      .values({ workspaceId: g.workspaceId, taskId: blocker.id, state: "active" });
    for (const status of ["active", "removed"] as const) {
      await db.insert(worktree).values({
        workspaceId: g.workspaceId,
        taskId: blocker.id,
        repositoryId: g.repositoryId,
        path: `.solow/worktrees/${status}`,
        branch: `solow/${status}`,
        status,
      });
    }

    expect(await taskDeletionImpact(ctx, blocker.id)).toEqual({
      ok: true,
      data: { sessionCount: 1, worktreeCount: 1, dependentCount: 1, running: true },
    });
  });
});
