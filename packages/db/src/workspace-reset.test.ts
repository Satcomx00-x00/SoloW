/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import {
  executorProfile,
  harnessCatalog,
  harnessProfile,
  issue,
  project,
  projectItem,
  repository,
  review,
  secret,
  session,
  sessionEvent,
  task,
  taskRepository,
  uiPreference,
  workspace,
  worktree,
} from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";
import { resetWorkspace } from "./workspace-reset.js";

/**
 * Emptying a Workspace (issue: workspace controls).
 *
 * Two things are being asserted, and the second matters more than the first. That the rows go is
 * easy; that the rows of *another* Workspace stay is the property the whole tenancy model rests
 * on (Principle V), and a whole-table `DELETE FROM` that forgot its `where` would pass every
 * other test in this file. So every case here runs against two Workspaces and checks the second
 * one afterwards.
 */

const OTHER = "ws-other";

async function seed(db: TestDb, workspaceId: string, name: string) {
  const w = workspaceId;
  await db.insert(workspace).values({ id: w, name, ownerUserId: `owner-${w}` });
  await db.insert(harnessCatalog).values({
    id: `cat-${w}`,
    workspaceId: w,
    key: "claude_code",
    displayName: "Claude Code",
    protocol: "claude_code_stream_json",
    command: "claude",
    subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  });
  await db.insert(secret).values({
    id: `sec-${w}`,
    workspaceId: w,
    name: "token",
    kind: "subscription_token",
    ciphertext: "ciphertext",
  });
  await db.insert(harnessProfile).values({
    id: `hp-${w}`,
    workspaceId: w,
    name: "Claude",
    agentCatalogId: `cat-${w}`,
    authMode: "subscription",
    secretId: `sec-${w}`,
  });
  await db.insert(executorProfile).values({ id: `ep-${w}`, workspaceId: w, name: "Local" });
  await db.insert(repository).values({
    id: `repo-${w}`,
    workspaceId: w,
    name: "fixture",
    source: "local_path",
    location: "/srv/repos/fixture",
  });
  await db.insert(project).values({ id: `proj-${w}`, workspaceId: w, title: "Work" });
  await db.insert(issue).values({ id: `iss-${w}`, workspaceId: w, title: "Ship it" });
  await db.insert(projectItem).values({
    id: `pi-${w}`,
    workspaceId: w,
    projectId: `proj-${w}`,
    issueId: `iss-${w}`,
    providerItemId: `item-${w}`,
  });
  await db.insert(task).values({
    id: `task-${w}`,
    workspaceId: w,
    issueId: `iss-${w}`,
    title: "Do it",
    agentProfileId: `hp-${w}`,
    executorProfileId: `ep-${w}`,
  });
  await db.insert(taskRepository).values({
    id: `tr-${w}`,
    workspaceId: w,
    taskId: `task-${w}`,
    repositoryId: `repo-${w}`,
    checkoutBranch: `solow/task-${w}`,
  });
  await db.insert(worktree).values({
    id: `wt-${w}`,
    workspaceId: w,
    taskId: `task-${w}`,
    repositoryId: `repo-${w}`,
    path: `/worktrees/${w}`,
    branch: `solow/task-${w}`,
  });
  await db.insert(session).values({ id: `ses-${w}`, workspaceId: w, taskId: `task-${w}` });
  await db.insert(sessionEvent).values({
    id: `ev-${w}`,
    workspaceId: w,
    sessionId: `ses-${w}`,
    seq: 1,
    kind: "stdout",
    payload: {},
  });
  await db.insert(review).values({
    id: `rev-${w}`,
    workspaceId: w,
    sessionId: `ses-${w}`,
    decision: "approve",
    actorUserId: "owner",
  });
  await db.insert(uiPreference).values({
    id: `pref-${w}`,
    workspaceId: w,
    userId: "owner",
    key: "appearance",
    value: { theme: "dark" },
  });
}

describe("resetWorkspace", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = createTestDb();
    await seed(db, "ws-1", "Mine");
    await seed(db, OTHER, "Theirs");
  });

  /**
   * Rows of `t` belonging to Workspace `id`. The `workspace` table is the one that identifies
   * itself by `id` rather than by `workspaceId` — it *is* the tenant — so it is matched on that
   * instead of silently filtering to nothing.
   */
  const rowsFor = async (t: any, id: string) =>
    (await db.select().from(t)).filter((row) =>
      t === workspace ? row["id"] === id : row["workspaceId"] === id,
    );

  it("work-data empties what the Workspace has done and keeps what it is", () => {
    const result = db.transaction((tx) => resetWorkspace(tx, "ws-1", "work-data"));

    expect(result.rows).toBeGreaterThan(0);
    expect(result.removed.map((entry) => entry.table)).toContain("task");
    expect(result.removed.map((entry) => entry.table)).toContain("issue");
    expect(result.removed.map((entry) => entry.table)).toContain("project");
  });

  it("work-data leaves the setup in place, so the Workspace can run again immediately", async () => {
    db.transaction((tx) => resetWorkspace(tx, "ws-1", "work-data"));

    // The point of the narrower scope: a credential, the harness that spends it and the machine
    // it runs on all survive. A reset that took these would be a factory reset wearing a
    // different label.
    expect(await rowsFor(secret, "ws-1")).toHaveLength(1);
    expect(await rowsFor(harnessProfile, "ws-1")).toHaveLength(1);
    expect(await rowsFor(executorProfile, "ws-1")).toHaveLength(1);
    expect(await rowsFor(repository, "ws-1")).toHaveLength(1);
    expect(await rowsFor(uiPreference, "ws-1")).toHaveLength(1);
  });

  it("work-data takes the whole Task subtree, not just the Task row", async () => {
    db.transaction((tx) => resetWorkspace(tx, "ws-1", "work-data"));

    for (const t of [task, taskRepository, worktree, session, sessionEvent, review]) {
      expect(await rowsFor(t, "ws-1")).toHaveLength(0);
    }
  });

  it("everything additionally removes the setup, and still keeps the Workspace and its catalog", async () => {
    db.transaction((tx) => resetWorkspace(tx, "ws-1", "everything"));

    expect(await rowsFor(secret, "ws-1")).toHaveLength(0);
    expect(await rowsFor(harnessProfile, "ws-1")).toHaveLength(0);
    expect(await rowsFor(repository, "ws-1")).toHaveLength(0);
    expect(await rowsFor(uiPreference, "ws-1")).toHaveLength(0);

    // The tenant the request arrived through, and the reference data a fresh install is seeded
    // with — neither is user data, and removing either would break the next boot rather than
    // clean anything up.
    expect(await rowsFor(workspace, "ws-1")).toHaveLength(1);
    expect(await rowsFor(harnessCatalog, "ws-1")).toHaveLength(1);
  });

  it("hands back each Task's worktree directories, read before the rows naming them were deleted", () => {
    const result = db.transaction((tx) => resetWorkspace(tx, "ws-1", "work-data"));

    // The orchestrator removes the checkouts on the far side of the Executor boundary, and by
    // then there is no row left to ask for the path (Decision 0025). Grouped by Task because
    // that is what `purgeTaskFiles` takes.
    expect(result.purge).toEqual([{ taskId: "task-ws-1", worktrees: ["/worktrees/ws-1"] }]);
  });

  it("touches no other Workspace's rows, at either scope (Principle V)", async () => {
    db.transaction((tx) => resetWorkspace(tx, "ws-1", "everything"));

    for (const t of [
      workspace,
      harnessCatalog,
      secret,
      harnessProfile,
      executorProfile,
      repository,
      project,
      projectItem,
      issue,
      task,
      taskRepository,
      worktree,
      session,
      sessionEvent,
      review,
      uiPreference,
    ]) {
      expect(await rowsFor(t, OTHER)).toHaveLength(1);
    }
  });

  it("is a no-op on a Workspace that has nothing, rather than an error", () => {
    db.transaction((tx) => resetWorkspace(tx, "ws-1", "everything"));
    const again = db.transaction((tx) => resetWorkspace(tx, "ws-1", "everything"));

    expect(again).toEqual({ removed: [], rows: 0, purge: [] });
  });
});
