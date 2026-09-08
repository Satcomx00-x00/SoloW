import { beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { CommonErrorCode, IntegrationErrorCode, RepositoryErrorCode } from "@solow/contracts";
import { createTestDb, type TestDb } from "@solow/db/testing";
import {
  connectRepository,
  disconnectRepository,
  getRepository,
  listRepositories,
  listRepositoryAssignees,
  listRepositoryLabels,
  listRepositoryMilestones,
  updateRepositorySetup,
} from "./repository.js";
import { createTaskRecord } from "./task.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * `repository.regression.ts` needs real network I/O against a fixture provider server and can't
 * run under this workspace's default `bun test` (happy-dom, preloaded globally for React
 * component tests, cannot parse Bun.serve's responses over loopback — see
 * `integration.regression.ts`'s header comment for the underlying compat bug). Same fix: run it
 * in an isolated subprocess with the no-happy-dom bunfig, and surface its result here.
 */
describe("repository DAL — listRepositoryLabels against a real provider (isolated subprocess)", () => {
  it("passes without happy-dom's fetch polyfill in the way", () => {
    const webRoot = path.resolve(import.meta.dir, "../../..");
    const result = spawnSync(
      "bun",
      ["--config=./bunfig.test-no-dom.toml", "test", "./src/server/dal/repository.regression.ts"],
      { cwd: webRoot, encoding: "utf8" },
    );

    if (result.status !== 0) {
      throw new Error(
        `repository.regression.ts failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
      );
    }
  });
});

/**
 * The setup-file allowlist (issue #52) decides which files are copied out of a Repository and
 * into a harness's worktree. It is a security-relevant list, so the tests that matter are the
 * ones about who may change it and what a Repository starts with.
 */
describe("repository setup files", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("starts empty — nothing is copied until an operator says so", async () => {
    const { workspaceId } = await seedWorkspaceGraph(db, "alpha");

    const listed = await listRepositories(ctxFor(db, workspaceId), {});

    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data.items[0]?.setupFilePatterns).toEqual([]);
  });

  it("replaces the list wholesale", async () => {
    const { workspaceId, repositoryId } = await seedWorkspaceGraph(db, "alpha");
    const ctx = ctxFor(db, workspaceId);

    await updateRepositorySetup(ctx, {
      repositoryId,
      setupFilePatterns: [".env", "config/local.json"],
    });
    const narrowed = await updateRepositorySetup(ctx, {
      repositoryId,
      setupFilePatterns: [".env"],
    });

    expect(narrowed.ok).toBe(true);
    if (narrowed.ok) expect(narrowed.data.setupFilePatterns).toEqual([".env"]);
    // Removing a pattern has to actually remove it: a merge here would mean an operator could
    // never stop copying a file they no longer trust the worktree with.
    const reread = await getRepository(ctx, repositoryId);
    if (reread.ok) expect(reread.data.setupFilePatterns).toEqual([".env"]);
  });

  it("cannot be changed from another Workspace (Principle V)", async () => {
    const alpha = await seedWorkspaceGraph(db, "alpha");
    const beta = await seedWorkspaceGraph(db, "beta");

    const attempt = await updateRepositorySetup(ctxFor(db, beta.workspaceId), {
      repositoryId: alpha.repositoryId,
      setupFilePatterns: [".env"],
    });

    expect(attempt.ok).toBe(false);
    const untouched = await getRepository(ctxFor(db, alpha.workspaceId), alpha.repositoryId);
    if (untouched.ok) expect(untouched.data.setupFilePatterns).toEqual([]);
  });
});

describe("listRepositoryLabels — non-network cases", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns NOT_LINKED for a local-path Repository with no Integration — nothing to fetch", async () => {
    const { workspaceId, repositoryId } = await seedWorkspaceGraph(db, "no-integration");

    const result = await listRepositoryLabels(ctxFor(db, workspaceId), repositoryId);

    expect(result).toEqual({ ok: false, error: IntegrationErrorCode.NotLinked });
  });

  it("returns NOT_FOUND for a Repository from another Workspace (Principle V)", async () => {
    const owner = await seedWorkspaceGraph(db, "labels-owner");
    const intruder = await seedWorkspaceGraph(db, "labels-intruder");

    const result = await listRepositoryLabels(ctxFor(db, intruder.workspaceId), owner.repositoryId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("NOT_FOUND");
  });
});

// The assignee and milestone pickers (F23a) share `loadRepositoryCredential` with the label
// picker, so they refuse the same two non-network shapes for the same reasons — asserted here so
// a future change to that shared guard cannot silently exempt one of them.
describe("listRepositoryAssignees / listRepositoryMilestones — non-network cases", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("both return NOT_LINKED for a local-path Repository with no Integration", async () => {
    const { workspaceId, repositoryId } = await seedWorkspaceGraph(db, "no-integration");
    const ctx = ctxFor(db, workspaceId);

    expect(await listRepositoryAssignees(ctx, repositoryId)).toEqual({
      ok: false,
      error: IntegrationErrorCode.NotLinked,
    });
    expect(await listRepositoryMilestones(ctx, repositoryId)).toEqual({
      ok: false,
      error: IntegrationErrorCode.NotLinked,
    });
  });

  it("both return NOT_FOUND for a Repository from another Workspace (Principle V)", async () => {
    const owner = await seedWorkspaceGraph(db, "members-owner");
    const intruder = await seedWorkspaceGraph(db, "members-intruder");
    const ctx = ctxFor(db, intruder.workspaceId);

    const assignees = await listRepositoryAssignees(ctx, owner.repositoryId);
    const milestones = await listRepositoryMilestones(ctx, owner.repositoryId);

    expect(assignees).toEqual({ ok: false, error: "NOT_FOUND" });
    expect(milestones).toEqual({ ok: false, error: "NOT_FOUND" });
  });
});

/**
 * Disconnecting a Repository.
 *
 * There was no delete path at all before this, so these are the first statements anywhere about
 * what disconnecting means. The refusal is the interesting half: `issue`, `task_repository`,
 * `project_repository` and `change_request` all carry real foreign keys with no cascade, and those
 * rows are the record of what a harness actually did in that repository. Losing them silently
 * would be worse than being unable to tidy the list.
 */
describe("repository DAL — disconnect", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("disconnects a Repository nothing holds", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const created = await connectRepository(ctx, {
      name: "spare",
      source: "local_path",
      location: "/srv/repos/spare",
    });
    if (!created.ok) throw new Error("seed failed");

    expect((await disconnectRepository(ctx, { id: created.data.id })).ok).toBe(true);
    expect(await getRepository(ctx, created.data.id)).toEqual({
      ok: false,
      error: CommonErrorCode.NotFound,
    });
  });

  it("refuses while an Issue still points at it", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    await seedIssue(db, g.workspaceId, { repositoryId: g.repositoryId });

    expect(await disconnectRepository(ctx, { id: g.repositoryId })).toEqual({
      ok: false,
      error: RepositoryErrorCode.InUse,
    });
  });

  it("refuses while a Task is still attached to it", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssue(db, g.workspaceId, { title: "Work to do" });
    const made = await createTaskRecord(ctx, {
      issueId: issue.id,
      title: "Touches the repo",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!made.ok) throw new Error("seed failed");

    expect(await disconnectRepository(ctx, { id: g.repositoryId })).toEqual({
      ok: false,
      error: RepositoryErrorCode.InUse,
    });
  });

  it("refuses a Repository belonging to another Workspace (Principle V)", async () => {
    const mine = await seedWorkspaceGraph(db, "acme");
    const theirs = await seedWorkspaceGraph(db, "other");
    const ctx = ctxFor(db, mine.workspaceId);

    expect(await disconnectRepository(ctx, { id: theirs.repositoryId })).toEqual({
      ok: false,
      error: CommonErrorCode.NotFound,
    });
  });
});
