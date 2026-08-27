/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  addIssueToProject,
  attachIssueToLocalProjects,
  backfillProjectFromRepository,
} from "./project-membership.js";
import { issue, project, projectItem, projectRepository, repository, workspace } from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";

/**
 * A local Project's membership (user request 2026-08-27): every Issue in a registered
 * Repository belongs to the Project, kept true as Issues arrive from either of the two places
 * one is created — a local Issue and #125's automatic per-Repository ingestion — which is why
 * this lives beside `createTestDb` rather than in either app's own test suite: both call it, and
 * one test proving the join is correct is what stops the two silently disagreeing.
 */
describe("project membership", () => {
  let db: TestDb;
  let workspaceId: string;
  let repoId: string;
  let projectId: string;

  beforeEach(async () => {
    db = createTestDb();
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Acme", ownerUserId: "owner-1" })
      .returning();
    workspaceId = ws?.id ?? "";
    const [repo] = await db
      .insert(repository)
      .values({ workspaceId, name: "gate-firmware", source: "local_path", location: "/repo" })
      .returning();
    repoId = repo?.id ?? "";
    const [proj] = await db
      .insert(project)
      .values({ workspaceId, title: "Firmware", integrationId: null, providerProjectId: null })
      .returning();
    projectId = proj?.id ?? "";
  });

  async function seedIssue(title: string, targetRepoId: string = repoId) {
    const [row] = await db
      .insert(issue)
      .values({ workspaceId, title, repositoryId: targetRepoId })
      .returning();
    if (!row) throw new Error("failed to seed issue");
    return row;
  }

  async function register(pid: string, rid: string) {
    await db.insert(projectRepository).values({ workspaceId, projectId: pid, repositoryId: rid });
  }

  async function itemsIn(pid: string) {
    return db.select().from(projectItem).where(eq(projectItem.projectId, pid));
  }

  describe("addIssueToProject", () => {
    it("appends at the next position", async () => {
      const a = await seedIssue("First");
      const b = await seedIssue("Second");
      await addIssueToProject(db, workspaceId, projectId, a.id);
      await addIssueToProject(db, workspaceId, projectId, b.id);

      const rows = (await itemsIn(projectId)).sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.issueId)).toEqual([a.id, b.id]);
      expect(rows.map((r) => r.position)).toEqual([0, 1]);
    });

    it("uses the Issue's own id as providerItemId — there is no provider item to name it after", async () => {
      const a = await seedIssue("Solo");
      await addIssueToProject(db, workspaceId, projectId, a.id);

      const [row] = await itemsIn(projectId);
      expect(row?.providerItemId).toBe(a.id);
    });

    it("is idempotent — attaching the same Issue twice writes one row, not two", async () => {
      const a = await seedIssue("Once");
      await addIssueToProject(db, workspaceId, projectId, a.id);
      await addIssueToProject(db, workspaceId, projectId, a.id);

      expect(await itemsIn(projectId)).toHaveLength(1);
    });
  });

  describe("backfillProjectFromRepository", () => {
    it("attaches every existing Issue in the Repository, oldest first", async () => {
      const a = await seedIssue("Older");
      const b = await seedIssue("Newer");

      const count = await backfillProjectFromRepository(db, workspaceId, projectId, repoId);

      expect(count).toBe(2);
      const rows = (await itemsIn(projectId)).sort((x, y) => x.position - y.position);
      expect(rows.map((r) => r.issueId)).toEqual([a.id, b.id]);
    });

    it("touches nothing when the Repository has no Issues yet", async () => {
      expect(await backfillProjectFromRepository(db, workspaceId, projectId, repoId)).toBe(0);
      expect(await itemsIn(projectId)).toHaveLength(0);
    });
  });

  describe("attachIssueToLocalProjects", () => {
    it("does nothing when the Issue's Repository feeds no local Project", async () => {
      const [otherRepo] = await db
        .insert(repository)
        .values({ workspaceId, name: "unrelated", source: "local_path", location: "/other" })
        .returning();
      const a = await seedIssue("Orphan", otherRepo?.id ?? "");

      await attachIssueToLocalProjects(db, workspaceId, {
        issueId: a.id,
        repositoryId: otherRepo?.id ?? "",
      });

      expect(await itemsIn(projectId)).toHaveLength(0);
    });

    it("attaches a new Issue to every local Project the Repository feeds — including more than one", async () => {
      const [secondProject] = await db
        .insert(project)
        .values({
          workspaceId,
          title: "Also firmware",
          integrationId: null,
          providerProjectId: null,
        })
        .returning();
      await register(projectId, repoId);
      await register(secondProject?.id ?? "", repoId);
      const a = await seedIssue("Fresh");

      await attachIssueToLocalProjects(db, workspaceId, { issueId: a.id, repositoryId: repoId });

      expect(await itemsIn(projectId)).toHaveLength(1);
      expect(await itemsIn(secondProject?.id ?? "")).toHaveLength(1);
    });

    it("is idempotent, the same way addIssueToProject is", async () => {
      await register(projectId, repoId);
      const a = await seedIssue("Twice");

      await attachIssueToLocalProjects(db, workspaceId, { issueId: a.id, repositoryId: repoId });
      await attachIssueToLocalProjects(db, workspaceId, { issueId: a.id, repositoryId: repoId });

      expect(await itemsIn(projectId)).toHaveLength(1);
    });

    it("is scoped to the Workspace — never crosses into another tenant's Projects", async () => {
      await register(projectId, repoId);
      const [otherWs] = await db
        .insert(workspace)
        .values({ name: "Other Co", ownerUserId: "owner-2" })
        .returning();
      const a = await seedIssue("Cross-tenant check");

      // A Repository id colliding across Workspaces cannot happen in practice (ids are UUIDs),
      // so this proves the query is scoped by workspaceId rather than merely correct by luck:
      // passing the *other* Workspace's id must see none of the real membership.
      await attachIssueToLocalProjects(db, otherWs?.id ?? "", {
        issueId: a.id,
        repositoryId: repoId,
      });

      expect(await itemsIn(projectId)).toHaveLength(0);
    });
  });
});
