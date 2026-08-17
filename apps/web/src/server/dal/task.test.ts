import { beforeEach, describe, expect, it } from "bun:test";
import { agentProfile, executorProfile, repository, workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import type { RequestContext } from "./context.js";
import { createIssueRecord, getIssueById } from "./issue.js";
import { createTaskRecord, getTaskById, listTasks } from "./task.js";

/** Seed the full FK chain a Task needs and return the ids required to create one. */
async function seedWorkspaceGraph(db: TestDb, name: string) {
  const [ws] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");

  const [agent] = await db
    .insert(agentProfile)
    .values({
      workspaceId: ws.id,
      name: "claude",
      authMode: "api_key",
      secretId: "secret-1",
    })
    .returning();
  const [executor] = await db
    .insert(executorProfile)
    .values({ workspaceId: ws.id, name: "local" })
    .returning();
  const [repo] = await db
    .insert(repository)
    .values({
      workspaceId: ws.id,
      name: "gatecontrol",
      source: "local_path",
      location: "/srv/repos/gatecontrol",
    })
    .returning();
  if (!agent || !executor || !repo) throw new Error("failed to seed profiles");

  return {
    workspaceId: ws.id,
    agentProfileId: agent.id,
    executorProfileId: executor.id,
    repositoryId: repo.id,
  };
}

function ctxFor(db: TestDb, workspaceId: string): RequestContext {
  return { db, workspaceId, userId: "user-1" };
}

describe("task DAL", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("createTaskRecord then getTaskById returns it in the backlog state", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await createIssueRecord(ctx, { title: "Needs work" });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Implement latch fix",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositoryId: g.repositoryId,
      state: "backlog",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.issueId).toBe(issue.data.id);
    expect(created.data.state).toBe("backlog");
    expect(created.data.baseRef).toBeNull();

    const fetched = await getTaskById(ctx, created.data.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data).toEqual(created.data);
  });

  it("getIssueById taskCount reflects tasks created for the issue", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await createIssueRecord(ctx, { title: "Two tasks" });
    if (!issue.ok) return;

    for (const title of ["t1", "t2"]) {
      await createTaskRecord(ctx, {
        issueId: issue.data.id,
        title,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositoryId: g.repositoryId,
        state: "backlog",
      });
    }

    const refetched = await getIssueById(ctx, issue.data.id);
    expect(refetched.ok).toBe(true);
    if (!refetched.ok) return;
    expect(refetched.data.taskCount).toBe(2);
  });

  it("listTasks filters by issueId within the workspace", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issueA = await createIssueRecord(ctx, { title: "A" });
    const issueB = await createIssueRecord(ctx, { title: "B" });
    if (!issueA.ok || !issueB.ok) return;

    const mk = (issueId: string, title: string) =>
      createTaskRecord(ctx, {
        issueId,
        title,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositoryId: g.repositoryId,
        state: "backlog",
      });
    await mk(issueA.data.id, "a-task");
    await mk(issueB.data.id, "b-task-1");
    await mk(issueB.data.id, "b-task-2");

    const onlyB = await listTasks(ctx, { issueId: issueB.data.id });
    expect(onlyB.ok).toBe(true);
    if (!onlyB.ok) return;
    expect(onlyB.data.length).toBe(2);
    expect(onlyB.data.every((t) => t.issueId === issueB.data.id)).toBe(true);
  });

  // Cross-workspace isolation (Principle V) for the task DAL.
  it("enforces cross-workspace isolation for getTaskById", async () => {
    const gA = await seedWorkspaceGraph(db, "workspace-a");
    const gB = await seedWorkspaceGraph(db, "workspace-b");
    const ctxA = ctxFor(db, gA.workspaceId);
    const ctxB = ctxFor(db, gB.workspaceId);

    const issueB = await createIssueRecord(ctxB, { title: "B's issue" });
    if (!issueB.ok) return;
    const taskB = await createTaskRecord(ctxB, {
      issueId: issueB.data.id,
      title: "B's task",
      agentProfileId: gB.agentProfileId,
      executorProfileId: gB.executorProfileId,
      repositoryId: gB.repositoryId,
      state: "backlog",
    });
    expect(taskB.ok).toBe(true);
    if (!taskB.ok) return;

    const leak = await getTaskById(ctxA, taskB.data.id);
    expect(leak.ok).toBe(false);
    if (leak.ok) return;
    expect(leak.error).toBe("NOT_FOUND");

    const listA = await listTasks(ctxA, {});
    expect(listA.ok).toBe(true);
    if (!listA.ok) return;
    expect(listA.data.length).toBe(0);
  });
});
