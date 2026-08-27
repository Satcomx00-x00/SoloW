/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IssueErrorCode } from "@solow/contracts";
import { session as sessionTable, task as taskTable, worktree } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { createTaskRecord } from "../dal/task.js";
import { ctxFor, seedWorkspaceGraph } from "../dal/test-fixtures.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * Force-deleting an Issue, end to end through the router against a real in-memory database.
 *
 * What this proves that the DAL tests cannot: the router stops running Tasks through the
 * orchestrator *before* it deletes, and the DAL's own re-check is what decides the outcome —
 * so a stop that did not actually take effect (the unwired dev path, which logs and returns)
 * leaves the Issue intact rather than cascading over a live agent.
 */

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

function caller(db: TestDb, workspaceId: string) {
  return appRouter.createCaller(ctx(db, workspaceId));
}

describe("issue.delete force", () => {
  let db: TestDb;
  // Both `devOwnerMode()` and `orchestratorUrl()` read `process.env` on every call, and other
  // router suites set SOLOW_DEV_OWNER process-wide. Pinning both here is what keeps the
  // two stop-failure branches below from swapping places depending on file order.
  const savedDevOwner = process.env.SOLOW_DEV_OWNER;
  const savedUrl = process.env.SOLOW_ORCHESTRATOR_URL;

  beforeEach(() => {
    db = createTestDb();
    delete process.env.SOLOW_ORCHESTRATOR_URL;
  });

  afterEach(() => {
    if (savedDevOwner === undefined) delete process.env.SOLOW_DEV_OWNER;
    else process.env.SOLOW_DEV_OWNER = savedDevOwner;
    if (savedUrl === undefined) delete process.env.SOLOW_ORCHESTRATOR_URL;
    else process.env.SOLOW_ORCHESTRATOR_URL = savedUrl;
  });

  it("deletes the Issue and its Tasks when nothing is running", async () => {
    process.env.SOLOW_DEV_OWNER = "off";
    const g = await seedWorkspaceGraph(db, "router-force");
    const api = caller(db, g.workspaceId);
    const created = await api.issue.create({
      title: "Abandoned",
      repositoryId: g.repositoryId,
      labels: [],
    });
    const made = await createTaskRecord(ctxFor(db, g.workspaceId), {
      issueId: created.id,
      title: "Gave up on this",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "failed",
    });
    if (!made.ok) throw new Error("task seed failed");

    await expect(api.issue.delete({ id: created.id, force: false })).rejects.toThrow(
      IssueErrorCode.HasTasks,
    );

    const result = await api.issue.delete({ id: created.id, force: true });
    expect(result).toEqual({ id: created.id, deletedTaskCount: 1 });
    expect(await db.select().from(taskTable).where(eq(taskTable.id, made.data.id))).toHaveLength(0);
  });

  it("deletes nothing when the running Tasks could not be stopped", async () => {
    process.env.SOLOW_DEV_OWNER = "off";
    const g = await seedWorkspaceGraph(db, "router-force-running");
    const api = caller(db, g.workspaceId);
    const created = await api.issue.create({
      title: "Still running",
      repositoryId: g.repositoryId,
      labels: [],
    });
    const made = await createTaskRecord(ctxFor(db, g.workspaceId), {
      issueId: created.id,
      title: "Agent is alive",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "running",
    });
    if (!made.ok) throw new Error("task seed failed");
    await db
      .insert(sessionTable)
      .values({ workspaceId: g.workspaceId, taskId: made.data.id, state: "active" });

    // No SOLOW_ORCHESTRATOR_URL in the test env, so the stop hand-off fails outright.
    // That must abort the whole delete: cascading anyway would drop the `task` row while its
    // agent kept running, with nothing left able to stop it. (The other half of this guard — a
    // stop that was accepted but has not taken effect yet — is the DAL's own re-check, covered
    // by `dal/issue.test.ts`'s HasRunningTasks case.)
    await expect(api.issue.delete({ id: created.id, force: true })).rejects.toThrow(
      IssueErrorCode.StopFailed,
    );

    expect(await api.issue.get({ id: created.id })).toMatchObject({ id: created.id });
    expect(await db.select().from(taskTable).where(eq(taskTable.id, made.data.id))).toHaveLength(1);
  });

  it("reports the impact the confirmation dialog states, counting only worktrees still on disk", async () => {
    process.env.SOLOW_DEV_OWNER = "off";
    const g = await seedWorkspaceGraph(db, "router-force-impact");
    const api = caller(db, g.workspaceId);
    const created = await api.issue.create({
      title: "Busy",
      repositoryId: g.repositoryId,
      labels: [],
    });
    const made = await createTaskRecord(ctxFor(db, g.workspaceId), {
      issueId: created.id,
      title: "Had a go",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "review",
    });
    if (!made.ok) throw new Error("task seed failed");
    await db
      .insert(sessionTable)
      .values({ workspaceId: g.workspaceId, taskId: made.data.id, state: "awaiting_review" });
    for (const status of ["active", "removed"] as const) {
      await db.insert(worktree).values({
        workspaceId: g.workspaceId,
        taskId: made.data.id,
        repositoryId: g.repositoryId,
        path: `.solow/worktrees/${status}`,
        branch: `solow/${status}`,
        status,
      });
    }

    expect(await api.issue.deletionImpact({ id: created.id })).toEqual({
      taskCount: 1,
      runningTaskCount: 0,
      sessionCount: 1,
      worktreeCount: 1,
    });
  });

  it("deletes nothing when the stop was accepted but the Task is still running", async () => {
    // Dev-owner mode with no orchestrator wired: `stopTaskRun` logs and returns successfully,
    // so the router proceeds — and the DAL's in-transaction re-check is then the only thing
    // preventing a cascade over a live agent. This is the branch the previous test cannot
    // reach, because there the stop never succeeds in the first place.
    process.env.SOLOW_DEV_OWNER = "on";
    const g = await seedWorkspaceGraph(db, "router-force-noop-stop");
    const api = caller(db, g.workspaceId);
    const created = await api.issue.create({
      title: "Stop went nowhere",
      repositoryId: g.repositoryId,
      labels: [],
    });
    const made = await createTaskRecord(ctxFor(db, g.workspaceId), {
      issueId: created.id,
      title: "Agent is alive",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "running",
    });
    if (!made.ok) throw new Error("task seed failed");

    await expect(api.issue.delete({ id: created.id, force: true })).rejects.toThrow(
      IssueErrorCode.HasRunningTasks,
    );
    expect(await db.select().from(taskTable).where(eq(taskTable.id, made.data.id))).toHaveLength(1);
  });
});
