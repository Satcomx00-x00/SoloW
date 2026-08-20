import { beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  changeRequest,
  integration,
  issue,
  repository,
  repositoryBranch,
  task,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import { deleteIntegration } from "./integration.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * `integration.regression.ts` needs real network I/O and can't run under this workspace's
 * default `bun test` (happy-dom, preloaded globally for React component tests, cannot parse
 * Bun.serve's responses — see that file's header comment). Run it in a separate `bun test`
 * process with a bunfig that skips the happy-dom preload, and surface its result here so it's
 * still part of the normal `bun test` / `make verify` run.
 */
describe("integration DAL — GitLab iid collision regression (isolated subprocess)", () => {
  it("passes without happy-dom's fetch polyfill in the way", () => {
    const webRoot = path.resolve(import.meta.dir, "../../..");
    const result = spawnSync(
      "bun",
      ["--config=./bunfig.test-no-dom.toml", "test", "./src/server/dal/integration.regression.ts"],
      { cwd: webRoot, encoding: "utf8" },
    );

    if (result.status !== 0) {
      throw new Error(
        `integration.regression.ts failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
      );
    }
  });
});

/**
 * Disconnecting an Integration (spec F12).
 *
 * These run in-process, unlike the regression suite above: deleting touches nothing but the
 * database, so there is no provider to stand up and no `fetch` for happy-dom to get wrong.
 *
 * What they pin down is the *asymmetry* — the synced cache goes, the work stays. Anything that
 * quietly turned this into a full cascade would take Tasks with it, which is exactly what the
 * `task.issue_id` foreign key makes unrecoverable.
 */
describe("deleteIntegration", () => {
  let db: TestDb;
  let workspaceId: string;
  let repositoryId: string;
  let integrationId: string;
  let profileIds: { agentProfileId: string; executorProfileId: string };

  /** A connected Integration with a linked Repository and one of everything synced from it. */
  beforeEach(async () => {
    db = createTestDb();
    const graph = await seedWorkspaceGraph(db, "acme");
    workspaceId = graph.workspaceId;
    repositoryId = graph.repositoryId;
    profileIds = graph;

    const [row] = await db
      .insert(integration)
      .values({ workspaceId, provider: "github", secretId: "secret-1", baseUrl: null })
      .returning();
    if (!row) throw new Error("failed to seed integration");
    integrationId = row.id;

    await db
      .update(repository)
      .set({ integrationId, externalFullName: "acme/gate" })
      .where(eq(repository.id, repositoryId));
    await db.insert(repositoryBranch).values({
      workspaceId,
      repositoryId,
      name: "main",
      isDefault: true,
      headSha: "abc123",
    });
    await db.insert(changeRequest).values({
      workspaceId,
      repositoryId,
      integrationId,
      externalId: "cr-1",
      number: 7,
      title: "A pull request",
      state: "open",
      url: "https://github.com/acme/gate/pull/7",
      headRef: "feature",
      baseRef: "main",
    });
  });

  /** An imported Issue with a Task attached — the work a disconnect must not destroy. */
  async function seedImportedIssueWithTask() {
    const [importedIssue] = await db
      .insert(issue)
      .values({
        workspaceId,
        title: "Imported from GitHub",
        source: "github",
        integrationId,
        repositoryId,
        externalId: "42",
        externalNumber: 42,
      })
      .returning();
    if (!importedIssue) throw new Error("failed to seed issue");

    const [attached] = await db
      .insert(task)
      .values({
        workspaceId,
        issueId: importedIssue.id,
        title: "Work on the imported issue",
        agentProfileId: profileIds.agentProfileId,
        executorProfileId: profileIds.executorProfileId,
        repositoryId,
      })
      .returning();
    if (!attached) throw new Error("failed to seed task");
    return { issueId: importedIssue.id, taskId: attached.id };
  }

  it("deletes the integration and reports what it touched", async () => {
    await seedImportedIssueWithTask();
    const result = await deleteIntegration(ctxFor(db, workspaceId), { id: integrationId });

    expect(result).toEqual({
      ok: true,
      data: {
        id: integrationId,
        repositoriesUnlinked: 1,
        branchesDeleted: 1,
        changeRequestsDeleted: 1,
        issuesDetached: 1,
      },
    });
    expect(
      await db.select().from(integration).where(eq(integration.id, integrationId)),
    ).toHaveLength(0);
  });

  it("unlinks the Repository instead of deleting it", async () => {
    await deleteIntegration(ctxFor(db, workspaceId), { id: integrationId });

    const [repo] = await db.select().from(repository).where(eq(repository.id, repositoryId));
    expect(repo).toBeDefined();
    // Both halves of the link are cleared: a name without an Integration would be a repository
    // the UI still shows as linked to an account that no longer exists.
    expect(repo?.integrationId).toBeNull();
    expect(repo?.externalFullName).toBeNull();
  });

  it("removes the synced cache — branches and change requests", async () => {
    await deleteIntegration(ctxFor(db, workspaceId), { id: integrationId });

    expect(
      await db
        .select()
        .from(repositoryBranch)
        .where(eq(repositoryBranch.repositoryId, repositoryId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(changeRequest).where(eq(changeRequest.repositoryId, repositoryId)),
    ).toHaveLength(0);
  });

  it("keeps imported Issues and the Tasks attached to them", async () => {
    const seeded = await seedImportedIssueWithTask();
    await deleteIntegration(ctxFor(db, workspaceId), { id: integrationId });

    const [kept] = await db.select().from(issue).where(eq(issue.id, seeded.issueId));
    expect(kept).toBeDefined();
    // Detached, not deleted: the provider link is gone, the work item and its history are not.
    expect(kept?.integrationId).toBeNull();
    expect(kept?.title).toBe("Imported from GitHub");
    expect(await db.select().from(task).where(eq(task.id, seeded.taskId))).toHaveLength(1);
  });

  it("succeeds on an Integration with nothing linked to it", async () => {
    const [bare] = await db
      .insert(integration)
      .values({ workspaceId, provider: "gitlab", secretId: "secret-1", baseUrl: null })
      .returning();
    if (!bare) throw new Error("failed to seed integration");

    expect(await deleteIntegration(ctxFor(db, workspaceId), { id: bare.id })).toEqual({
      ok: true,
      data: {
        id: bare.id,
        repositoriesUnlinked: 0,
        branchesDeleted: 0,
        changeRequestsDeleted: 0,
        issuesDetached: 0,
      },
    });
  });

  it("cannot delete another Workspace's Integration", async () => {
    const other = await seedWorkspaceGraph(db, "other");

    expect(await deleteIntegration(ctxFor(db, other.workspaceId), { id: integrationId })).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
    // Nothing was touched on the way to refusing — not the integration, not its linked repository.
    expect(
      await db.select().from(integration).where(eq(integration.id, integrationId)),
    ).toHaveLength(1);
    const [repo] = await db.select().from(repository).where(eq(repository.id, repositoryId));
    expect(repo?.integrationId).toBe(integrationId);
  });

  it("reports NOT_FOUND for an unknown id", async () => {
    expect(await deleteIntegration(ctxFor(db, workspaceId), { id: "no-such-integration" })).toEqual(
      {
        ok: false,
        error: "NOT_FOUND",
      },
    );
  });
});
