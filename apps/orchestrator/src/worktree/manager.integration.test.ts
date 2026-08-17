import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import {
  cleanupWorktree,
  commitWorktree,
  hasChanges,
  provisionWorktree,
  type Worktree,
} from "./manager.js";

/**
 * Integration test: exercises the real git worktree lifecycle against a throwaway repo.
 * Provision -> detect no changes -> mutate -> detect changes -> commit -> cleanup.
 */

let repoDir: string;
let worktreeRoot: string;
let repoCacheRoot: string;

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "gc-repo-"));
  worktreeRoot = mkdtempSync(join(tmpdir(), "gc-wt-"));
  repoCacheRoot = mkdtempSync(join(tmpdir(), "gc-cache-"));

  await $`git -C ${repoDir} init -q`.quiet();
  await $`git -C ${repoDir} config user.email t@e.com`.quiet();
  await $`git -C ${repoDir} config user.name Test`.quiet();
  writeFileSync(join(repoDir, "README.md"), "initial\n");
  await $`git -C ${repoDir} add -A`.quiet();
  await $`git -C ${repoDir} commit -q -m init`.quiet();
});

afterAll(() => {
  for (const dir of [worktreeRoot, repoCacheRoot, repoDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("provisionWorktree lifecycle (local_path)", () => {
  let wt: Worktree;

  it("provisions an isolated worktree that starts clean", async () => {
    wt = await provisionWorktree({
      taskId: "task-77",
      repository: { source: "local_path", location: repoDir },
      worktreeRoot,
      repoCacheRoot,
    });

    expect(wt.path).toBe(join(worktreeRoot, "task-77"));
    expect(wt.branch).toBe("gatecontrol/task-task-77");
    expect(wt.repoPath).toBe(repoDir);
    expect(existsSync(wt.path)).toBe(true);
    // Inherited README from HEAD is committed, so a fresh worktree has no diff.
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    expect(await hasChanges(wt.path)).toBe(false);
  });

  it("detects uncommitted changes then commits them", async () => {
    writeFileSync(join(wt.path, "agent-output.txt"), "the agent wrote this\n");
    expect(await hasChanges(wt.path)).toBe(true);

    await commitWorktree(wt.path, "agent changes");
    // After committing, the tree is clean again.
    expect(await hasChanges(wt.path)).toBe(false);

    const log = await $`git -C ${wt.path} log -1 --pretty=%s`.quiet().text();
    expect(log.trim()).toBe("agent changes");
  });

  it("removes the worktree on cleanup", async () => {
    await cleanupWorktree(wt.repoPath, wt.path);
    expect(existsSync(wt.path)).toBe(false);
  });
});
