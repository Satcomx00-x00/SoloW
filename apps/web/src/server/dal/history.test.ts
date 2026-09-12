/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { TASK_RETENTION_MS } from "@solow/core";
import { session, task as taskTable, worktree } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { listHistory } from "./history.js";
import { createTaskRecord, deleteTask, updateTaskState } from "./task.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * History (Decision 0025): who is in it, in what order, for how long, and what a resume would do.
 * The resumability rule is the one the orchestrator acts on — a worktree still on disk plus a
 * recorded conversation — so it is pinned against rows rather than against the UI's wording.
 */
describe("listHistory", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  async function seed() {
    const g = await seedWorkspaceGraph(db, "history");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssue(db, g.workspaceId, { title: "Fix the latch" });
    const make = async (title: string) => {
      const made = await createTaskRecord(ctx, {
        issueId: issue.id,
        title,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositories: [{ repositoryId: g.repositoryId }],
        state: "backlog",
      });
      if (!made.ok) throw new Error("task seed failed");
      return made.data;
    };
    return { g, ctx, issue, make };
  }

  it("lists deleted and Done tasks inside the window, newest first, and nothing live", async () => {
    const { ctx, make } = await seed();
    const live = await make("Still on the board");
    const gone = await make("Deleted yesterday");
    const shipped = await make("Shipped last week");
    await deleteTask(ctx, { id: gone.id, force: false });
    await updateTaskState(ctx, shipped.id, "done");
    // Done six days ago: inside the window, and older than the deletion.
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
    await db.update(taskTable).set({ updatedAt: sixDaysAgo }).where(eq(taskTable.id, shipped.id));
    const stale = await make("Done long ago");
    await updateTaskState(ctx, stale.id, "done");
    const longAgo = new Date(Date.now() - TASK_RETENTION_MS - 3600 * 1000).toISOString();
    await db.update(taskTable).set({ updatedAt: longAgo }).where(eq(taskTable.id, stale.id));

    const result = await listHistory(ctx);
    if (!result.ok) throw new Error("history failed");

    expect(result.data.map((e) => [e.task.id, e.kind])).toEqual([
      [gone.id, "deleted"],
      [shipped.id, "done"],
    ]);
    expect(result.data.map((e) => e.task.id)).not.toContain(live.id);
    expect(result.data[0]?.issueTitle).toBe("Fix the latch");
    expect(result.data[0]?.repositoryName).toBeTruthy();
    // Expiry is the window from the mark, not from now.
    expect(new Date(result.data[1]?.expiresAt ?? "").getTime()).toBeCloseTo(
      new Date(sixDaysAgo).getTime() + TASK_RETENTION_MS,
      -3,
    );
  });

  it("says what a resume would do: continue, start from the brief, or nothing", async () => {
    const { g, ctx, make } = await seed();
    const never = await make("Never ran");
    const brief = await make("Ran, worktree gone");
    const conversation = await make("Ran, worktree kept");
    for (const t of [never, brief, conversation]) await updateTaskState(ctx, t.id, "done");
    await db.insert(session).values([
      { workspaceId: g.workspaceId, taskId: brief.id, state: "closed", harnessSessionId: "c-1" },
      {
        workspaceId: g.workspaceId,
        taskId: conversation.id,
        state: "resumable",
        harnessSessionId: "c-2",
      },
    ]);
    await db.insert(worktree).values([
      {
        workspaceId: g.workspaceId,
        taskId: brief.id,
        repositoryId: g.repositoryId,
        path: "/wt/brief",
        branch: "b",
        status: "removed",
      },
      {
        workspaceId: g.workspaceId,
        taskId: conversation.id,
        repositoryId: g.repositoryId,
        path: "/wt/conversation",
        branch: "c",
        status: "active",
      },
    ]);

    const result = await listHistory(ctx);
    if (!result.ok) throw new Error("history failed");
    const by = new Map(result.data.map((e) => [e.task.id, e.resumable]));
    expect(by.get(never.id)).toBe("none");
    expect(by.get(brief.id)).toBe("brief");
    expect(by.get(conversation.id)).toBe("conversation");
  });
});
