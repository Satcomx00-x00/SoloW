import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createLocalExecutor } from "../executor/local.js";
import type { Executor } from "../executor/types.js";
import {
  adoptWorktree,
  cleanupWorktree,
  commitWorktree,
  DIFF_PATCH_LIMIT,
  diffWorktree,
  hasChanges,
  listWorktrees,
  prepareRepository,
  provisionWorktree,
  type Worktree,
} from "./manager.js";

/**
 * Integration test: exercises the real git worktree lifecycle against a throwaway repo.
 * Provision -> detect no changes -> mutate -> detect changes -> commit -> cleanup.
 *
 * Fixture setup (`beforeAll`) and a couple of direct assertions still shell out with Bun's `$` —
 * that is test scaffolding standing in for a human `git log`, not the code under test, which is
 * why it is exempt from the executor-boundary audit that applies to `manager.ts` itself.
 */

let repoDir: string;
let worktreeRoot: string;
let repoCacheRoot: string;
let executor: Executor;

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "gc-repo-"));
  worktreeRoot = mkdtempSync(join(tmpdir(), "gc-wt-"));
  repoCacheRoot = mkdtempSync(join(tmpdir(), "gc-cache-"));
  executor = createLocalExecutor(worktreeRoot);

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
    wt = await provisionWorktree(executor, {
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
    expect(await hasChanges(executor, wt.path)).toBe(false);
  });

  it("detects uncommitted changes then commits them", async () => {
    writeFileSync(join(wt.path, "agent-output.txt"), "the agent wrote this\n");
    expect(await hasChanges(executor, wt.path)).toBe(true);

    await commitWorktree(executor, wt.path, "agent changes");
    // After committing, the tree is clean again.
    expect(await hasChanges(executor, wt.path)).toBe(false);

    const log = await $`git -C ${wt.path} log -1 --pretty=%s`.quiet().text();
    expect(log.trim()).toBe("agent changes");
  });

  it("removes the worktree on cleanup", async () => {
    await cleanupWorktree(executor, wt.repoPath, wt.path);
    expect(existsSync(wt.path)).toBe(false);
  });
});

/**
 * The diff a reviewer is shown (TASK-022). Against real git, because the thing most likely to be
 * wrong is which changes git reports — in particular that a file the agent *created* shows up at
 * all, which plain `git diff` will not tell you.
 *
 * Each case gets its own worktree. Sharing one made the tests order-dependent: a case that
 * committed to set up a deletion wiped the changes a later case was asserting on.
 */
describe("diffWorktree", () => {
  let counter = 0;
  const worktrees: Worktree[] = [];

  /** A fresh worktree off the fixture repo, cleaned up when the suite ends. */
  async function freshWorktree(): Promise<Worktree> {
    counter += 1;
    const wt = await provisionWorktree(executor, {
      taskId: `diff-${counter}`,
      repository: { source: "local_path", location: repoDir },
      worktreeRoot,
      repoCacheRoot,
    });
    worktrees.push(wt);
    return wt;
  }

  afterAll(async () => {
    for (const wt of worktrees) {
      if (existsSync(wt.path)) await cleanupWorktree(executor, wt.repoPath, wt.path);
    }
  });

  it("reports nothing when the agent changed nothing", async () => {
    const diff = await diffWorktree(executor, (await freshWorktree()).path);
    expect(diff.files).toEqual([]);
    expect(diff.patch).toBe("");
    expect(diff.truncated).toBe(false);
  });

  it("includes a file the agent created, not just ones it edited", async () => {
    // An untracked file is invisible to `git diff`, so without the intent-to-add step the most
    // interesting change an agent makes — a new module — would be missing from the review.
    const wt = await freshWorktree();
    writeFileSync(join(wt.path, "new-module.ts"), "export const answer = 42;\n");

    const diff = await diffWorktree(executor, wt.path);
    const created = diff.files.find((f) => f.path === "new-module.ts");
    expect(created?.status).toBe("added");
    expect(created?.additions).toBe(1);
    expect(diff.patch).toContain("export const answer = 42;");
  });

  it("counts additions and deletions on an edited file", async () => {
    const wt = await freshWorktree();
    writeFileSync(join(wt.path, "README.md"), "rewritten\nsecond line\n");

    const edited = (await diffWorktree(executor, wt.path)).files.find(
      (f) => f.path === "README.md",
    );
    expect(edited?.status).toBe("modified");
    expect(edited?.additions).toBe(2);
    expect(edited?.deletions).toBe(1);
  });

  it("records a deletion", async () => {
    const wt = await freshWorktree();
    rmSync(join(wt.path, "README.md"));

    const diff = await diffWorktree(executor, wt.path);
    expect(diff.files.find((f) => f.path === "README.md")?.status).toBe("deleted");
  });

  it("truncates a huge patch but never the file list", async () => {
    // The patch lands in one SQLite row that the review page loads whole, so it is bounded. The
    // file list is what a reviewer scans first and stays complete.
    const wt = await freshWorktree();
    writeFileSync(join(wt.path, "huge.txt"), `${"x".repeat(DIFF_PATCH_LIMIT * 2)}\n`);
    writeFileSync(join(wt.path, "small.txt"), "also changed\n");

    const diff = await diffWorktree(executor, wt.path);
    expect(diff.truncated).toBe(true);
    expect(diff.patch.length).toBe(DIFF_PATCH_LIMIT);
    expect(diff.files.some((f) => f.path === "huge.txt")).toBe(true);
    expect(diff.files.some((f) => f.path === "small.txt")).toBe(true);
  });

  it("leaves the worktree committable, so intent-to-add did not break the approve path", async () => {
    const wt = await freshWorktree();
    writeFileSync(join(wt.path, "added-by-agent.ts"), "export const x = 1;\n");
    await diffWorktree(executor, wt.path);

    await commitWorktree(executor, wt.path, "GateControl: diff test");
    expect(await hasChanges(executor, wt.path)).toBe(false);
    const shown = await $`git -C ${wt.path} show --name-only --format=`.quiet().text();
    expect(shown).toContain("added-by-agent.ts");
  });
});

/**
 * Adopting the worktree the agent created (task TASK-014).
 *
 * `claude --worktree` makes the directory, so GateControl no longer picks it — it confirms with
 * git that the path the agent reported really is a worktree of this repository, and refuses
 * anything else. That refusal is the isolation guarantee (Principle II): committing from a
 * directory we could not verify would be worse than failing the Task.
 */
describe("prepareRepository and adoptWorktree", () => {
  it("prepares a local repository without creating a Task worktree", async () => {
    const before = await listWorktrees(executor, repoDir);
    const prepared = await prepareRepository(executor, {
      taskId: "adopt-1",
      repository: { source: "local_path", location: repoDir },
      worktreeRoot,
      repoCacheRoot,
    });

    expect(prepared).toBe(repoDir);
    // The agent makes the worktree, so preparing must not have made one.
    expect(await listWorktrees(executor, repoDir)).toHaveLength(before.length);
  });

  it("fails before any agent starts when the location is not a repository", async () => {
    // TASK-015: an unusable repository fails the Task up front rather than surfacing later as a
    // confusing agent error.
    const notARepo = mkdtempSync(join(tmpdir(), "gc-notrepo-"));
    await expect(
      prepareRepository(executor, {
        taskId: "adopt-2",
        repository: { source: "local_path", location: notARepo },
        worktreeRoot,
        repoCacheRoot,
      }),
    ).rejects.toThrow(/not a git repository/);
    rmSync(notARepo, { recursive: true, force: true });
  });

  it("adopts a worktree the agent created, reading its branch from git", async () => {
    // Stands in for what `claude --worktree gatecontrol-task-9` does.
    const agentPath = join(worktreeRoot, "gatecontrol-task-9");
    await $`git -C ${repoDir} worktree add -b gatecontrol-task-9 ${agentPath}`.quiet();

    const adopted = await adoptWorktree(executor, repoDir, agentPath);
    expect(adopted.path).toBe(agentPath);
    expect(adopted.branch).toBe("gatecontrol-task-9");
    expect(adopted.repoPath).toBe(repoDir);

    await cleanupWorktree(executor, repoDir, agentPath);
  });

  it("refuses a path that is not a worktree of this repository", async () => {
    // An agent working somewhere unverified has not been isolated; committing from there could
    // mix another Task's changes into this one's branch.
    const stray = mkdtempSync(join(tmpdir(), "gc-stray-"));
    await expect(adoptWorktree(executor, repoDir, stray)).rejects.toThrow(/refusing to use it/);
    rmSync(stray, { recursive: true, force: true });
  });

  it("refuses when the agent reported no workspace at all", async () => {
    await expect(adoptWorktree(executor, repoDir, null)).rejects.toThrow(
      /did not report a workspace/,
    );
  });

  it("lists concurrent worktrees separately, which is what makes parallel Tasks safe", async () => {
    // Two Tasks, one repository: each agent gets its own directory and its own branch.
    const a = join(worktreeRoot, "gatecontrol-task-a");
    const b = join(worktreeRoot, "gatecontrol-task-b");
    await $`git -C ${repoDir} worktree add -b gatecontrol-task-a ${a}`.quiet();
    await $`git -C ${repoDir} worktree add -b gatecontrol-task-b ${b}`.quiet();

    const adoptedA = await adoptWorktree(executor, repoDir, a);
    const adoptedB = await adoptWorktree(executor, repoDir, b);
    expect(adoptedA.path).not.toBe(adoptedB.path);
    expect(adoptedA.branch).not.toBe(adoptedB.branch);

    writeFileSync(join(a, "only-a.txt"), "a\n");
    expect(existsSync(join(b, "only-a.txt"))).toBe(false);

    await cleanupWorktree(executor, repoDir, a);
    await cleanupWorktree(executor, repoDir, b);
  });
});
