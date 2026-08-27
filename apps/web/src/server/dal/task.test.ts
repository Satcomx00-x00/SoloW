import { beforeEach, describe, expect, it } from "bun:test";
import { TaskErrorCode } from "@solow/contracts";
import { CREDENTIAL_EXPIRED_REASON } from "@solow/core";
import { agentProfile, repository } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { getIssueById } from "./issue.js";
import {
  createTaskRecord,
  getTaskById,
  listTasks,
  setTaskRepositories,
  taskIdsBlockedByCredential,
  updateTaskState,
} from "./task.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Issue #15 removed public Issue creation; tests here only need *an* Issue to exist, so this
 * inserts one directly and wraps it in the same {ok, data:{id}} shape `createIssueRecord` used
 * to return, keeping the rest of this file's assertions unchanged.
 */
async function seedIssueOk(db: TestDb, ctx: RequestContext, overrides: { title: string }) {
  const row = await seedIssue(db, ctx.workspaceId, overrides);
  return { ok: true as const, data: { id: row.id } };
}

describe("task DAL", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("createTaskRecord then getTaskById returns it in the backlog state", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Needs work" });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;

    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Implement latch fix",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.issueId).toBe(issue.data.id);
    expect(created.data.state).toBe("backlog");
    expect(created.data.repositories).toHaveLength(1);
    expect(created.data.repositories[0]?.repositoryId).toBe(g.repositoryId);
    expect(created.data.repositories[0]?.baseRef).toBeNull();
    // Derived server-side rather than left null: the unique key is (task, repository, branch),
    // and SQLite treats every NULL as distinct.
    expect(created.data.repositories[0]?.checkoutBranch).toBe(`solow/task-${created.data.id}`);

    const fetched = await getTaskById(ctx, created.data.id);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.data).toEqual(created.data);
  });

  it("getIssueById taskCount reflects tasks created for the issue", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Two tasks" });
    if (!issue.ok) return;

    for (const title of ["t1", "t2"]) {
      await createTaskRecord(ctx, {
        issueId: issue.data.id,
        title,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositories: [{ repositoryId: g.repositoryId }],
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
    const issueA = await seedIssueOk(db, ctx, { title: "A" });
    const issueB = await seedIssueOk(db, ctx, { title: "B" });
    if (!issueA.ok || !issueB.ok) return;

    const mk = (issueId: string, title: string) =>
      createTaskRecord(ctx, {
        issueId,
        title,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositories: [{ repositoryId: g.repositoryId }],
        state: "backlog",
      });
    await mk(issueA.data.id, "a-task");
    await mk(issueB.data.id, "b-task-1");
    await mk(issueB.data.id, "b-task-2");

    const onlyB = await listTasks(ctx, { issueId: issueB.data.id });
    expect(onlyB.ok).toBe(true);
    if (!onlyB.ok) return;
    expect(onlyB.data.items.length).toBe(2);
    expect(onlyB.data.items.every((t) => t.issueId === issueB.data.id)).toBe(true);
  });

  it("listTasks filters by title query, and does not silently ignore it", async () => {
    // The input schema accepted `query` while the DAL dropped it, so a search came back
    // unfiltered and looked like it had worked — worse than an error.
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Gate" });
    if (!issue.ok) return;

    const mk = (title: string) =>
      createTaskRecord(ctx, {
        issueId: issue.data.id,
        title,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositories: [{ repositoryId: g.repositoryId }],
        state: "backlog",
      });
    await mk("Debounce the keypad backlight");
    await mk("Replace the servo stall detector");

    const hits = await listTasks(ctx, { query: "servo" });
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    expect(hits.data.items.map((t) => t.title)).toEqual(["Replace the servo stall detector"]);

    const none = await listTasks(ctx, { query: "nothing matches this" });
    expect(none.ok && none.data.items).toEqual([]);
  });

  // Cross-workspace isolation (Principle V) for the task DAL.
  it("enforces cross-workspace isolation for getTaskById", async () => {
    const gA = await seedWorkspaceGraph(db, "workspace-a");
    const gB = await seedWorkspaceGraph(db, "workspace-b");
    const ctxA = ctxFor(db, gA.workspaceId);
    const ctxB = ctxFor(db, gB.workspaceId);

    const issueB = await seedIssueOk(db, ctxB, { title: "B's issue" });
    if (!issueB.ok) return;
    const taskB = await createTaskRecord(ctxB, {
      issueId: issueB.data.id,
      title: "B's task",
      agentProfileId: gB.agentProfileId,
      executorProfileId: gB.executorProfileId,
      repositories: [{ repositoryId: gB.repositoryId }],
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
    expect(listA.data.items.length).toBe(0);
  });
});

/**
 * The Task ↔ Repository join from the DAL's side (issue #7). A Task now names several
 * Repositories, and the questions that matter are: does every attachment survive the write,
 * does position 0 stay the one the agent will run in, and can the set be replaced safely.
 */
describe("a Task's Repository attachments", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  /** A second Repository in the same Workspace, so a Task has something else to attach. */
  async function secondRepository(workspaceId: string, name: string): Promise<string> {
    const [row] = await db
      .insert(repository)
      .values({ workspaceId, name, source: "local_path", location: `/srv/${name}` })
      .returning();
    if (!row) throw new Error("failed to seed repository");
    return row.id;
  }

  it("writes one attachment per entry, in the order the Owner listed them", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Spans two repos" });
    if (!issue.ok) return;
    const second = await secondRepository(g.workspaceId, "shared-lib");

    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Cross-repository change",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [
        { repositoryId: g.repositoryId, baseRef: "main" },
        { repositoryId: second, baseRef: "develop", checkoutBranch: "feature/lib" },
      ],
      state: "backlog",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Array order becomes `position`, and position 0 is the worktree the agent is started in —
    // so "which repository did the Owner mean first" is answered by the row, not by a re-sort.
    expect(created.data.repositories.map((r) => r.position)).toEqual([0, 1]);
    expect(created.data.repositories.map((r) => r.repositoryId)).toEqual([g.repositoryId, second]);
    expect(created.data.repositories.map((r) => r.baseRef)).toEqual(["main", "develop"]);
    expect(created.data.repositories[1]?.checkoutBranch).toBe("feature/lib");

    const reread = await getTaskById(ctx, created.data.id);
    expect(reread.ok && reread.data.repositories).toEqual(created.data.repositories);
  });

  it("hydrates every listed Task's attachments, not just the first", async () => {
    // The board reads a page of cards at once; a per-card query would be one round trip per
    // Task, and a query that forgot to key by Task would give every card the same repositories.
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Two tasks" });
    if (!issue.ok) return;
    const second = await secondRepository(g.workspaceId, "shared-lib");

    const mk = (title: string, repositoryIds: string[]) =>
      createTaskRecord(ctx, {
        issueId: issue.data.id,
        title,
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        repositories: repositoryIds.map((repositoryId) => ({ repositoryId })),
        state: "backlog",
      });
    await mk("one repo", [g.repositoryId]);
    await mk("two repos", [g.repositoryId, second]);

    const listed = await listTasks(ctx, {});
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const byTitle = Object.fromEntries(
      listed.data.items.map((t) => [t.title, t.repositories.length]),
    );
    expect(byTitle).toEqual({ "one repo": 1, "two repos": 2 });
  });

  it("never shows another Workspace's attachments (Principle V)", async () => {
    const gA = await seedWorkspaceGraph(db, "workspace-a");
    const gB = await seedWorkspaceGraph(db, "workspace-b");
    const ctxA = ctxFor(db, gA.workspaceId);
    const ctxB = ctxFor(db, gB.workspaceId);
    const issueA = await seedIssueOk(db, ctxA, { title: "A's issue" });
    const issueB = await seedIssueOk(db, ctxB, { title: "B's issue" });
    if (!issueA.ok || !issueB.ok) return;

    await createTaskRecord(ctxB, {
      issueId: issueB.data.id,
      title: "B's task",
      agentProfileId: gB.agentProfileId,
      executorProfileId: gB.executorProfileId,
      repositories: [{ repositoryId: gB.repositoryId }],
      state: "backlog",
    });
    const taskA = await createTaskRecord(ctxA, {
      issueId: issueA.data.id,
      title: "A's task",
      agentProfileId: gA.agentProfileId,
      executorProfileId: gA.executorProfileId,
      repositories: [{ repositoryId: gA.repositoryId }],
      state: "backlog",
    });

    expect(taskA.ok).toBe(true);
    if (!taskA.ok) return;
    expect(taskA.data.repositories.map((r) => r.repositoryId)).toEqual([gA.repositoryId]);
  });

  it("setTaskRepositories replaces the whole set rather than merging into it", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Repointed" });
    if (!issue.ok) return;
    const second = await secondRepository(g.workspaceId, "shared-lib");
    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Repointed",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!created.ok) return;

    const replaced = await setTaskRepositories(ctx, {
      taskId: created.data.id,
      repositories: [{ repositoryId: second, baseRef: "develop" }],
    });

    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    // The Owner sent a state of the world, so the repository they dropped is gone, not demoted.
    expect(replaced.data.repositories.map((r) => r.repositoryId)).toEqual([second]);
    const reread = await getTaskById(ctx, created.data.id);
    expect(reread.ok && reread.data.repositories.map((r) => r.repositoryId)).toEqual([second]);
  });

  it("refuses to re-point a Task whose worktrees are already live", async () => {
    // Re-pointing a running Task would orphan directories nothing else knows how to find, and
    // leave the agent working in a repository the Task no longer claims (Principle II).
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Running" });
    if (!issue.ok) return;
    const second = await secondRepository(g.workspaceId, "shared-lib");
    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Running",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "running",
    });
    if (!created.ok) return;

    const refused = await setTaskRepositories(ctx, {
      taskId: created.data.id,
      repositories: [{ repositoryId: second }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe(TaskErrorCode.IllegalTransition);
    // And nothing was written: the refusal and the delete are one transaction.
    const reread = await getTaskById(ctx, created.data.id);
    expect(reread.ok && reread.data.repositories.map((r) => r.repositoryId)).toEqual([
      g.repositoryId,
    ]);
  });

  it("will not re-point another Workspace's Task (Principle V)", async () => {
    const gA = await seedWorkspaceGraph(db, "workspace-a");
    const gB = await seedWorkspaceGraph(db, "workspace-b");
    const ctxA = ctxFor(db, gA.workspaceId);
    const ctxB = ctxFor(db, gB.workspaceId);
    const issueB = await seedIssueOk(db, ctxB, { title: "B's issue" });
    if (!issueB.ok) return;
    const taskB = await createTaskRecord(ctxB, {
      issueId: issueB.data.id,
      title: "B's task",
      agentProfileId: gB.agentProfileId,
      executorProfileId: gB.executorProfileId,
      repositories: [{ repositoryId: gB.repositoryId }],
      state: "backlog",
    });
    if (!taskB.ok) return;

    const refused = await setTaskRepositories(ctxA, {
      taskId: taskB.data.id,
      repositories: [{ repositoryId: gA.repositoryId }],
    });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe("NOT_FOUND");
  });

  it("leaves no half-created Task behind when an attachment cannot be written", async () => {
    // The insert pair is one transaction: a Task with no attachment cannot be launched at all,
    // so a half-created one is an unrunnable row nothing would ever clean up.
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Bad attachment" });
    if (!issue.ok) return;

    await expect(
      createTaskRecord(ctx, {
        issueId: issue.data.id,
        title: "Bad attachment",
        agentProfileId: g.agentProfileId,
        executorProfileId: g.executorProfileId,
        // A repository id that does not exist — the foreign key refuses the attachment insert.
        repositories: [{ repositoryId: "repo-that-does-not-exist" }],
        state: "backlog",
      }),
    ).rejects.toThrow();

    const listed = await listTasks(ctx, {});
    expect(listed.ok && listed.data.items).toEqual([]);
  });
});

/**
 * Tasks blocked on a credential (spec AC-013, issue #63) — the query that lets a Secret write
 * find every Task it should resume, so an Owner replacing an expired credential does not have
 * to find and retry each one by hand.
 */
describe("taskIdsBlockedByCredential", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("finds a failed Task whose Agent Profile spends the given Secret", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Stuck on a credential" });
    if (!issue.ok) return;
    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Stuck",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!created.ok) throw new Error("seed failed");
    await updateTaskState(ctx, created.data.id, "failed", {
      failureReason: CREDENTIAL_EXPIRED_REASON,
    });

    // `seedWorkspaceGraph`'s Agent Profile spends the literal Secret id "secret-1" (test-fixtures.ts).
    expect(await taskIdsBlockedByCredential(ctx, "secret-1")).toEqual([created.data.id]);
    expect(await taskIdsBlockedByCredential(ctx, "some-other-secret")).toEqual([]);
  });

  it("ignores a Task failed for any other reason", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Failed, but not on a credential" });
    if (!issue.ok) return;
    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Ordinary failure",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!created.ok) throw new Error("seed failed");
    await updateTaskState(ctx, created.data.id, "failed", { failureReason: "fail" });

    expect(await taskIdsBlockedByCredential(ctx, "secret-1")).toEqual([]);
  });

  it("ignores a Task that is not (or no longer) failed", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssueOk(db, ctx, { title: "Already resumed" });
    if (!issue.ok) return;
    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Back to running",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!created.ok) throw new Error("seed failed");
    // A Task that has already been resumed (state moved on, failureReason cleared) must not be
    // found again — a second `secret.set` for an unrelated reason must not resume it twice.
    await updateTaskState(ctx, created.data.id, "running", { failureReason: null });

    expect(await taskIdsBlockedByCredential(ctx, "secret-1")).toEqual([]);
  });

  it("does not cross Agent Profiles that happen to share a workspace but not a Secret", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const [existing] = await db
      .select({ agentCatalogId: agentProfile.agentCatalogId })
      .from(agentProfile)
      .where(eq(agentProfile.id, g.agentProfileId));
    if (!existing) throw new Error("seed failed");
    const [other] = await db
      .insert(agentProfile)
      .values({
        workspaceId: g.workspaceId,
        name: "a second profile",
        agentCatalogId: existing.agentCatalogId,
        authMode: "api_key",
        secretId: "secret-2",
      })
      .returning();
    if (!other) throw new Error("seed failed");

    const issue = await seedIssueOk(db, ctx, { title: "On the other profile" });
    if (!issue.ok) return;
    const created = await createTaskRecord(ctx, {
      issueId: issue.data.id,
      title: "Different credential",
      agentProfileId: other.id,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!created.ok) throw new Error("seed failed");
    await updateTaskState(ctx, created.data.id, "failed", {
      failureReason: CREDENTIAL_EXPIRED_REASON,
    });

    expect(await taskIdsBlockedByCredential(ctx, "secret-1")).toEqual([]);
    expect(await taskIdsBlockedByCredential(ctx, "secret-2")).toEqual([created.data.id]);
  });

  it("cannot see another Workspace's Task, even one blocked on the identically-named Secret", async () => {
    const a = await seedWorkspaceGraph(db, "workspace-a");
    const b = await seedWorkspaceGraph(db, "workspace-b");
    const ctxA = ctxFor(db, a.workspaceId);
    const ctxB = ctxFor(db, b.workspaceId);
    const issueA = await seedIssueOk(db, ctxA, { title: "A's stuck task" });
    if (!issueA.ok) return;
    const created = await createTaskRecord(ctxA, {
      issueId: issueA.data.id,
      title: "A's task",
      agentProfileId: a.agentProfileId,
      executorProfileId: a.executorProfileId,
      repositories: [{ repositoryId: a.repositoryId }],
      state: "backlog",
    });
    if (!created.ok) throw new Error("seed failed");
    await updateTaskState(ctxA, created.data.id, "failed", {
      failureReason: CREDENTIAL_EXPIRED_REASON,
    });

    // Both fixtures' default Agent Profile spends the same literal Secret id ("secret-1"), so
    // this is the case that actually exercises the workspace scope rather than a Secret mismatch.
    expect(await taskIdsBlockedByCredential(ctxB, "secret-1")).toEqual([]);
  });
});
