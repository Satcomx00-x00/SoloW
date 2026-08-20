import { beforeEach, describe, expect, it } from "bun:test";
import { CommonErrorCode, IssueErrorCode, type TaskState } from "@gatecontrol/contracts";
import { session, taskDependency, task as taskTable, workspace, worktree } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import {
  createIssue,
  deleteIssue,
  getIssueById,
  issueDeletionImpact,
  listIssues,
  runningTasksForIssue,
  updateIssue,
} from "./issue.js";
import { createTaskRecord } from "./task.js";
import { seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/** Insert a workspace row (Issues FK-reference it) and return its id. */
async function seedWorkspace(db: TestDb, name: string): Promise<string> {
  const [row] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!row) throw new Error("failed to seed workspace");
  return row.id;
}

function ctxFor(db: TestDb, workspaceId: string): RequestContext {
  return { db, workspaceId, userId: "user-1" };
}

describe("issue DAL", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("getIssueById reads back an Issue with taskCount 0", async () => {
    const wsId = await seedWorkspace(db, "acme");
    const ctx = ctxFor(db, wsId);
    const created = await seedIssue(db, wsId, {
      title: "Fix the gate latch",
      description: "The latch sticks in the rain",
    });

    const fetched = await getIssueById(ctx, created.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data.title).toBe("Fix the gate latch");
    expect(fetched.data.description).toBe("The latch sticks in the rain");
    expect(fetched.data.status).toBe("open");
    expect(fetched.data.taskCount).toBe(0);
    // Nothing seeded a source explicitly, so it reads back "local" — the value existing rows
    // (and every direct-DB fixture like this one) carry.
    expect(fetched.data.source).toBe("local");
  });

  it("an Issue with no description reads back null, not undefined", async () => {
    const wsId = await seedWorkspace(db, "acme");
    const created = await seedIssue(db, wsId, { title: "No details" });
    const fetched = await getIssueById(ctxFor(db, wsId), created.id);
    expect(fetched.ok && fetched.data.description).toBeNull();
  });

  it("getIssueById returns NOT_FOUND for an unknown id", async () => {
    const ctx = ctxFor(db, await seedWorkspace(db, "acme"));
    const res = await getIssueById(ctx, "does-not-exist");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("NOT_FOUND");
  });

  it("listIssues returns the seeded issues for the workspace", async () => {
    const wsId = await seedWorkspace(db, "acme");
    await seedIssue(db, wsId, { title: "First" });
    await seedIssue(db, wsId, { title: "Second" });

    const res = await listIssues(ctxFor(db, wsId), {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(2);
    const titles = res.data.map((i) => i.title).sort();
    expect(titles).toEqual(["First", "Second"]);
    for (const dto of res.data) expect(dto.taskCount).toBe(0);
  });

  it("listIssues filters by title query", async () => {
    const wsId = await seedWorkspace(db, "acme");
    await seedIssue(db, wsId, { title: "Gate motor whines" });
    await seedIssue(db, wsId, { title: "Keypad unresponsive" });

    const res = await listIssues(ctxFor(db, wsId), { query: "motor" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(1);
    expect(res.data[0]?.title).toBe("Gate motor whines");
  });

  // Cross-workspace isolation (constitution Principle V): a ctx scoped to workspace A
  // must never be able to read a row that belongs to workspace B.
  it("enforces cross-workspace isolation for getIssueById", async () => {
    const wsA = await seedWorkspace(db, "workspace-a");
    const wsB = await seedWorkspace(db, "workspace-b");
    const issueA = await seedIssue(db, wsA, { title: "A's issue" });
    const issueB = await seedIssue(db, wsB, { title: "B's issue" });

    // A tries to read B's issue by id -> NOT_FOUND, not a leak.
    const leak = await getIssueById(ctxFor(db, wsA), issueB.id);
    expect(leak.ok).toBe(false);
    if (leak.ok) return;
    expect(leak.error).toBe("NOT_FOUND");

    // Each workspace still sees only its own issue.
    const ownA = await getIssueById(ctxFor(db, wsA), issueA.id);
    expect(ownA.ok).toBe(true);
  });

  it("listIssues is scoped to the calling workspace only", async () => {
    const wsA = await seedWorkspace(db, "workspace-a");
    const wsB = await seedWorkspace(db, "workspace-b");
    await seedIssue(db, wsA, { title: "A only" });
    await seedIssue(db, wsB, { title: "B one" });
    await seedIssue(db, wsB, { title: "B two" });

    const listA = await listIssues(ctxFor(db, wsA), {});
    expect(listA.ok).toBe(true);
    if (!listA.ok) return;
    expect(listA.data.map((i) => i.title)).toEqual(["A only"]);

    const listB = await listIssues(ctxFor(db, wsB), {});
    expect(listB.ok).toBe(true);
    if (!listB.ok) return;
    expect(listB.data.length).toBe(2);
  });
});

describe("issue status is derived from its Tasks (FR-006)", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  /** Create an Issue with Tasks in the given states, and read its status back. */
  async function statusWith(states: TaskState[]): Promise<string> {
    const g = await seedWorkspaceGraph(db, `derive-${states.join("-") || "none"}`);
    const ctx = ctxFor(db, g.workspaceId);
    const seeded = await seedIssue(db, g.workspaceId, { title: "Gate servo stalls" });

    for (const [index, state] of states.entries()) {
      const created = await createTaskRecord(ctx, {
        issueId: seeded.id,
        title: `task-${index}`,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositories: [{ repositoryId: g.repositoryId }],
        state,
      });
      if (!created.ok) throw new Error("task seed failed");
    }

    const read = await getIssueById(ctx, seeded.id);
    if (!read.ok) throw new Error("read failed");
    return read.data.status;
  }

  it("is Open with no Tasks", async () => {
    expect(await statusWith([])).toBe("open");
  });

  it("is In progress while any Task is still moving", async () => {
    // The bug this covers: `deriveIssueStatus` existed and was never called, so an Issue whose
    // agents were mid-run still reported "Open" — the column is written once and never updated.
    expect(await statusWith(["running"])).toBe("in_progress");
    expect(await statusWith(["done", "review"])).toBe("in_progress");
  });

  it("is Resolved once every Task is Done", async () => {
    expect(await statusWith(["done", "done"])).toBe("resolved");
  });

  it("reports the same status through the list as through the single read", async () => {
    const g = await seedWorkspaceGraph(db, "derive-list");
    const ctx = ctxFor(db, g.workspaceId);
    const seeded = await seedIssue(db, g.workspaceId, { title: "Keypad backlight" });
    await createTaskRecord(ctx, {
      issueId: seeded.id,
      title: "t",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "running",
    });

    const listed = await listIssues(ctx, {});
    expect(listed.ok && listed.data[0]?.status).toBe("in_progress");

    // And the status filter matches on what the caller is actually shown, not on the column.
    const inProgress = await listIssues(ctx, { status: "in_progress" });
    expect(inProgress.ok && inProgress.data.length).toBe(1);
    const open = await listIssues(ctx, { status: "open" });
    expect(open.ok && open.data.length).toBe(0);
  });
});

describe("createIssue (issue #15 reversal)", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("creates a local Issue with labels, readable back through listIssues", async () => {
    const g = await seedWorkspaceGraph(db, "create");
    const ctx = ctxFor(db, g.workspaceId);

    const created = await createIssue(ctx, {
      title: "Keypad stops responding after rain",
      description: "Happens only above 90% humidity",
      repositoryId: g.repositoryId,
      labels: ["hardware", "weather"],
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.source).toBe("local");
    expect(created.data.labels).toEqual(["hardware", "weather"]);
    expect(created.data.repositoryId).toBe(g.repositoryId);

    const listed = await listIssues(ctx, {});
    expect(listed.ok && listed.data[0]?.labels).toEqual(["hardware", "weather"]);
  });

  it("refuses a repositoryId that belongs to another Workspace (Principle V)", async () => {
    const a = await seedWorkspaceGraph(db, "create-a");
    const b = await seedWorkspaceGraph(db, "create-b");

    const result = await createIssue(ctxFor(db, a.workspaceId), {
      title: "Cross-workspace attempt",
      repositoryId: b.repositoryId,
      labels: [],
    });

    expect(result).toEqual({ ok: false, error: CommonErrorCode.NotFound });
  });
});

describe("updateIssue (issue #15 reversal)", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("changes title, description and labels on a local Issue", async () => {
    const g = await seedWorkspaceGraph(db, "update-local");
    const ctx = ctxFor(db, g.workspaceId);
    const created = await createIssue(ctx, {
      title: "Original title",
      repositoryId: g.repositoryId,
      labels: ["bug"],
    });
    if (!created.ok) throw new Error("seed failed");

    const updated = await updateIssue(ctx, {
      id: created.data.id,
      title: "Revised title",
      description: "Added after triage",
      labels: ["bug", "triaged"],
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.title).toBe("Revised title");
    expect(updated.data.description).toBe("Added after triage");
    expect(updated.data.labels).toEqual(["bug", "triaged"]);
  });

  it("refuses a title/description change on an imported Issue with ISSUE_SOURCE_OWNED", async () => {
    const g = await seedWorkspaceGraph(db, "update-imported");
    const ctx = ctxFor(db, g.workspaceId);
    const imported = await seedIssue(db, g.workspaceId, {
      title: "Provider's own title",
      source: "github",
      repositoryId: g.repositoryId,
    });

    const attempt = await updateIssue(ctx, { id: imported.id, title: "GateControl's title" });

    expect(attempt).toEqual({ ok: false, error: IssueErrorCode.SourceOwned });
    const reread = await getIssueById(ctx, imported.id);
    expect(reread.ok && reread.data.title).toBe("Provider's own title");
  });

  it("still allows a labels-only update on an imported Issue, the one field every Issue owns", async () => {
    const g = await seedWorkspaceGraph(db, "update-imported-labels");
    const ctx = ctxFor(db, g.workspaceId);
    const imported = await seedIssue(db, g.workspaceId, {
      title: "Provider's own title",
      source: "gitlab",
      repositoryId: g.repositoryId,
    });

    const updated = await updateIssue(ctx, { id: imported.id, labels: ["needs-review"] });

    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.data.labels).toEqual(["needs-review"]);
  });

  it("returns NOT_FOUND for an Issue outside the caller's Workspace", async () => {
    const a = await seedWorkspaceGraph(db, "update-a");
    const b = await seedWorkspaceGraph(db, "update-b");
    const created = await createIssue(ctxFor(db, a.workspaceId), {
      title: "A's issue",
      repositoryId: a.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");

    const attempt = await updateIssue(ctxFor(db, b.workspaceId), {
      id: created.data.id,
      title: "Stolen edit",
    });

    expect(attempt).toEqual({ ok: false, error: CommonErrorCode.NotFound });
  });
});

describe("deleteIssue (issue #15 reversal)", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("removes an Issue with no Tasks", async () => {
    const g = await seedWorkspaceGraph(db, "delete-clean");
    const ctx = ctxFor(db, g.workspaceId);
    const created = await createIssue(ctx, {
      title: "Never picked up",
      repositoryId: g.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");

    const deleted = await deleteIssue(ctx, { id: created.data.id, force: false });
    expect(deleted).toEqual({ ok: true, data: { id: created.data.id, deletedTaskCount: 0 } });

    const reread = await getIssueById(ctx, created.data.id);
    expect(reread.ok).toBe(false);
  });

  it("runs the has-Tasks check and the delete as one atomic step, leaving no window for a Task to sneak in between them", async () => {
    const g = await seedWorkspaceGraph(db, "delete-atomic");
    const ctx = ctxFor(db, g.workspaceId);
    const created = await createIssue(ctx, {
      title: "Nothing should be able to race this",
      repositoryId: g.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");

    const resultPromise = deleteIssue(ctx, { id: created.data.id, force: false });
    // deleteIssue wraps its check and its delete in one `ctx.db.transaction()` call and awaits
    // nothing before returning it, so — by ordinary async/await semantics — the whole thing has
    // already run to completion by the time this line executes, before we've even awaited
    // `resultPromise`. Reading the Issue back here and finding it already gone is what proves
    // there is no gap left for a concurrently created Task to land in between the check and the
    // delete; the old two-`await` shape had no such guarantee and would still show the Issue as
    // present at this point, since its own delete statement hadn't run yet.
    const immediatelyAfter = await getIssueById(ctx, created.data.id);
    expect(immediatelyAfter.ok).toBe(false);

    const result = await resultPromise;
    expect(result).toEqual({ ok: true, data: { id: created.data.id, deletedTaskCount: 0 } });
  });

  it("refuses to delete an Issue that still has a Task, and leaves it untouched (spec F01)", async () => {
    const g = await seedWorkspaceGraph(db, "delete-blocked");
    const ctx = ctxFor(db, g.workspaceId);
    const created = await createIssue(ctx, {
      title: "Has a task against it",
      repositoryId: g.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");
    const task = await createTaskRecord(ctx, {
      issueId: created.data.id,
      title: "Work in progress",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!task.ok) throw new Error("task seed failed");

    const attempt = await deleteIssue(ctx, { id: created.data.id, force: false });

    expect(attempt).toEqual({ ok: false, error: IssueErrorCode.HasTasks });
    const reread = await getIssueById(ctx, created.data.id);
    expect(reread.ok).toBe(true);
  });

  it("cannot be used to delete an Issue in another Workspace (Principle V)", async () => {
    const a = await seedWorkspaceGraph(db, "delete-a");
    const b = await seedWorkspaceGraph(db, "delete-b");
    const created = await createIssue(ctxFor(db, a.workspaceId), {
      title: "A's issue",
      repositoryId: a.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");

    const attempt = await deleteIssue(ctxFor(db, b.workspaceId), {
      id: created.data.id,
      force: false,
    });

    expect(attempt).toEqual({ ok: false, error: CommonErrorCode.NotFound });
    const stillThere = await getIssueById(ctxFor(db, a.workspaceId), created.data.id);
    expect(stillThere.ok).toBe(true);
  });

  it("force deletes an Issue together with its Tasks and everything hanging off them", async () => {
    const g = await seedWorkspaceGraph(db, "delete-force");
    const ctx = ctxFor(db, g.workspaceId);
    const created = await createIssue(ctx, {
      title: "Abandoned line of work",
      repositoryId: g.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");
    const made = await createTaskRecord(ctx, {
      issueId: created.data.id,
      title: "Half-finished",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "failed",
    });
    if (!made.ok) throw new Error("task seed failed");
    const taskId = made.data.id;

    // A closed session and a worktree record, the two children a real abandoned Task leaves.
    await db
      .insert(session)
      .values({ workspaceId: g.workspaceId, taskId, state: "closed" })
      .returning();
    await db.insert(worktree).values({
      workspaceId: g.workspaceId,
      taskId,
      repositoryId: g.repositoryId,
      path: ".gatecontrol/worktrees/x",
      branch: "gatecontrol/x",
      status: "active",
    });

    const deleted = await deleteIssue(ctx, { id: created.data.id, force: true });
    expect(deleted).toEqual({ ok: true, data: { id: created.data.id, deletedTaskCount: 1 } });

    expect(await getIssueById(ctx, created.data.id)).toMatchObject({ ok: false });
    expect(await db.select().from(taskTable).where(eq(taskTable.id, taskId))).toHaveLength(0);
    expect(await db.select().from(session).where(eq(session.taskId, taskId))).toHaveLength(0);
    expect(await db.select().from(worktree).where(eq(worktree.taskId, taskId))).toHaveLength(0);
  });

  it("refuses a force delete while a Task is still running, so no agent is left orphaned", async () => {
    const g = await seedWorkspaceGraph(db, "delete-force-running");
    const ctx = ctxFor(db, g.workspaceId);
    const created = await createIssue(ctx, {
      title: "Still going",
      repositoryId: g.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");
    const made = await createTaskRecord(ctx, {
      issueId: created.data.id,
      title: "Running right now",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "running",
    });
    if (!made.ok) throw new Error("task seed failed");

    const attempt = await deleteIssue(ctx, { id: created.data.id, force: true });

    expect(attempt).toEqual({ ok: false, error: IssueErrorCode.HasRunningTasks });
    expect(await getIssueById(ctx, created.data.id)).toMatchObject({ ok: true });
  });

  it("clears dependency edges that point AT a deleted Task, so a surviving Task is not left blocked by a row that is gone", async () => {
    const g = await seedWorkspaceGraph(db, "delete-force-edges");
    const ctx = ctxFor(db, g.workspaceId);
    const doomedIssue = await createIssue(ctx, {
      title: "Blocker",
      repositoryId: g.repositoryId,
      labels: [],
    });
    const keptIssue = await createIssue(ctx, {
      title: "Survivor",
      repositoryId: g.repositoryId,
      labels: [],
    });
    if (!doomedIssue.ok || !keptIssue.ok) throw new Error("seed failed");

    const base = {
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog" as const,
    };
    const doomed = await createTaskRecord(ctx, {
      ...base,
      issueId: doomedIssue.data.id,
      title: "Blocks the other one",
    });
    const kept = await createTaskRecord(ctx, {
      ...base,
      issueId: keptIssue.data.id,
      title: "Waiting on it",
    });
    if (!doomed.ok || !kept.ok) throw new Error("task seed failed");

    await db.insert(taskDependency).values({
      workspaceId: g.workspaceId,
      taskId: kept.data.id,
      blockedByTaskId: doomed.data.id,
    });

    const deleted = await deleteIssue(ctx, { id: doomedIssue.data.id, force: true });
    expect(deleted.ok).toBe(true);

    const edges = await db
      .select()
      .from(taskDependency)
      .where(eq(taskDependency.taskId, kept.data.id));
    expect(edges).toHaveLength(0);
    expect(await db.select().from(taskTable).where(eq(taskTable.id, kept.data.id))).toHaveLength(1);
  });

  it("cannot force delete across Workspaces (Principle V)", async () => {
    const a = await seedWorkspaceGraph(db, "delete-force-a");
    const b = await seedWorkspaceGraph(db, "delete-force-b");
    const created = await createIssue(ctxFor(db, a.workspaceId), {
      title: "A's issue",
      repositoryId: a.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");

    const attempt = await deleteIssue(ctxFor(db, b.workspaceId), {
      id: created.data.id,
      force: true,
    });

    expect(attempt).toEqual({ ok: false, error: CommonErrorCode.NotFound });
    expect(await getIssueById(ctxFor(db, a.workspaceId), created.data.id)).toMatchObject({
      ok: true,
    });
  });

  it("counts what a force delete would destroy, and lists the sessions to stop first", async () => {
    const g = await seedWorkspaceGraph(db, "delete-impact");
    const ctx = ctxFor(db, g.workspaceId);
    const created = await createIssue(ctx, {
      title: "Busy issue",
      repositoryId: g.repositoryId,
      labels: [],
    });
    if (!created.ok) throw new Error("seed failed");
    const made = await createTaskRecord(ctx, {
      issueId: created.data.id,
      title: "Running",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "running",
    });
    if (!made.ok) throw new Error("task seed failed");
    const [live] = await db
      .insert(session)
      .values({ workspaceId: g.workspaceId, taskId: made.data.id, state: "active" })
      .returning();
    if (!live) throw new Error("session seed failed");
    await db.insert(worktree).values({
      workspaceId: g.workspaceId,
      taskId: made.data.id,
      repositoryId: g.repositoryId,
      path: ".gatecontrol/worktrees/live",
      branch: "gatecontrol/live",
      status: "active",
    });
    // A `removed` worktree has no directory left, so it must not be counted in the warning.
    await db.insert(worktree).values({
      workspaceId: g.workspaceId,
      taskId: made.data.id,
      repositoryId: g.repositoryId,
      path: ".gatecontrol/worktrees/old",
      branch: "gatecontrol/old",
      status: "removed",
    });

    const impact = await issueDeletionImpact(ctx, created.data.id);
    expect(impact).toEqual({
      ok: true,
      data: { taskCount: 1, runningTaskCount: 1, sessionCount: 1, worktreeCount: 1 },
    });

    expect(await runningTasksForIssue(ctx, created.data.id)).toEqual([
      { taskId: made.data.id, sessionId: live.id },
    ]);
  });
});
