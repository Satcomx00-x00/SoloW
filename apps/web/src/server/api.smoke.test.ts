/// <reference types="bun-types" />

import { beforeAll, describe, expect, it } from "bun:test";
import { repository, task } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { seedWorkspaceGraph } from "./dal/test-fixtures.js";
import { appRouter } from "./routers/index.js";
import type { BaseContext } from "./trpc.js";

/**
 * API smoke: the navigation's whole data path, one user's morning, through the real router and a
 * real (in-memory) database — no handler stubs, no DAL called directly once the fixture exists.
 *
 * Each step leans on the one before it, which is the point of a smoke test and the opposite of a
 * unit test: it fails when the pieces stop fitting together, even if every piece still passes on
 * its own. Run by `make smoke` as well as with the unit tests.
 */

let db: TestDb;
let graph: Awaited<ReturnType<typeof seedWorkspaceGraph>>;
let api: ReturnType<typeof appRouter.createCaller>;
/** A second repository, which no Project tracks: its Issues are the unassigned ones. */
let looseRepositoryId = "";

beforeAll(async () => {
  db = createTestDb();
  graph = await seedWorkspaceGraph(db, "smoke");
  const ctx: BaseContext = {
    db,
    session: { workspaceId: graph.workspaceId, userId: "smoke-user" },
    flagOverrides: { "ff-core-program": true, "ff-workflows": true },
  };
  api = appRouter.createCaller(ctx);
  const [loose] = await db
    .insert(repository)
    .values({
      workspaceId: graph.workspaceId,
      name: "scratch",
      source: "local_path",
      location: "/srv/repos/scratch",
    })
    .returning();
  looseRepositoryId = loose?.id ?? "";
});

describe("API smoke — from an empty Workspace to a Task waiting on review", () => {
  let projectId = "";
  let heldIssueId = "";
  let looseIssueId = "";
  let taskId = "";

  it("starts with nothing to count and nothing recent", async () => {
    expect(await api.workspace.counts()).toEqual({ unassignedIssues: 0, reviewByProject: [] });
    expect(await api.task.recent({})).toEqual([]);
    expect(await api.project.list({})).toEqual([]);
  });

  it("creates a Project, and lists it", async () => {
    const created = await api.project.createLocal({ title: "Smoke project" });
    projectId = created.id;
    const listed = await api.project.list({});
    expect(listed.map((p) => p.title)).toEqual(["Smoke project"]);
  });

  it("files an Issue on a repository the Project tracks under the Project", async () => {
    await api.project.attachRepository({ projectId, repositoryId: graph.repositoryId });
    const held = await api.issue.create({
      title: "Held by the project",
      repositoryId: graph.repositoryId,
      labels: [],
    });
    heldIssueId = held.id;
    expect(await api.project.forIssue({ issueId: heldIssueId })).toEqual({ projectId });
  });

  it("counts an Issue in no Project as unassigned, and lists the same one", async () => {
    const loose = await api.issue.create({
      title: "In no project",
      repositoryId: looseRepositoryId,
      labels: [],
    });
    looseIssueId = loose.id;

    const counts = await api.workspace.counts();
    const page = await api.issue.list({ unassigned: true, limit: 100 });
    expect(counts.unassignedIssues).toBe(page.items.length);
    expect(page.items.map((i) => i.id)).toContain(looseIssueId);
    expect(page.items.map((i) => i.id)).not.toContain(heldIssueId);
  });

  it("creates a Task on the held Issue and places it in the Project", async () => {
    const created = await api.task.create({
      issueId: heldIssueId,
      title: "Smoke task",
      agentProfileId: graph.agentProfileId,
      executorProfileId: graph.executorProfileId,
      repositories: [{ repositoryId: graph.repositoryId }],
    });
    taskId = created.id;
    const fetched = await api.task.get({ id: taskId });
    expect((await api.project.forIssue({ issueId: fetched.issueId })).projectId).toBe(projectId);
  });

  it("remembers the Task once opened, with the Project it lives in", async () => {
    await api.preference.recordRecentTask({ taskId });
    const recent = await api.task.recent({});
    expect(recent).toHaveLength(1);
    expect(recent[0]?.task.id).toBe(taskId);
    expect(recent[0]?.project).toEqual({ id: projectId, title: "Smoke project" });
  });

  it("counts the Task against its Project once it waits on review", async () => {
    // The run is the orchestrator's; reaching the gate is a state the smoke sets directly.
    await db.update(task).set({ state: "review" }).where(eq(task.id, taskId));
    const counts = await api.workspace.counts();
    expect(counts.reviewByProject).toEqual([{ projectId, tasks: 1 }]);
  });

  it("stops counting it once it is deleted, and drops it from the recent list", async () => {
    await db.update(task).set({ deletedAt: new Date().toISOString() }).where(eq(task.id, taskId));
    expect((await api.workspace.counts()).reviewByProject).toEqual([]);
    expect(await api.task.recent({})).toEqual([]);
  });

  it("installs the Spec Kit pipeline with Steps that raise open questions as decisions", async () => {
    const store = await api.workflow.store({});
    const speckit = store.find((entry) => entry.id === "speckit-sdd");
    expect(speckit).toBeDefined();
    const { workflow } = await api.workflow.installFromStore({
      entryId: "speckit-sdd",
      harnessProfileId: graph.agentProfileId,
    });
    const specify = workflow.steps.find((s) => s.name === "Specify");
    expect(specify?.promptTemplate).toContain("as a decision for the reviewer");
    expect((await api.workflow.list({})).map((w) => w.id)).toContain(workflow.id);
  });
});
