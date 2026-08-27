import { beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { IntegrationErrorCode } from "@solow/contracts";
import { createTestDb, type TestDb } from "@solow/db/testing";
import {
  getRepository,
  listRepositories,
  listRepositoryLabels,
  updateRepositorySetup,
} from "./repository.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

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
