import { beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { getRepository, listRepositories, updateRepositorySetup } from "./repository.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * The setup-file allowlist (issue #52) decides which files are copied out of a Repository and
 * into an agent's worktree. It is a security-relevant list, so the tests that matter are the
 * ones about who may change it and what a Repository starts with.
 */
describe("repository setup files", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("starts empty — nothing is copied until an operator says so", async () => {
    const { workspaceId } = await seedWorkspaceGraph(db, "alpha");

    const listed = await listRepositories(ctxFor(db, workspaceId));

    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.data[0]?.setupFilePatterns).toEqual([]);
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
