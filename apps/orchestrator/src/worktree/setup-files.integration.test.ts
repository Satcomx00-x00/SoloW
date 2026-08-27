import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createLocalExecutor } from "../executor/local.js";
import type { Executor } from "../executor/types.js";
import { commitWorktree, diffWorktree, hasChanges, provisionWorktree } from "./manager.js";
import { seedSetupFiles, setupFileExclusions } from "./setup-files.js";

/**
 * Integration test for the setup-file allowlist (issue #52), against a real git repository —
 * the matching is git's, so a fake executor would only prove that the arguments were spelled
 * the way this test spells them.
 *
 * The fixture is deliberately awkward: an ignored `.env`, an ignored nested `config/local.json`,
 * an ignored `node_modules` full of files nobody asked for, and a tracked `README.md`. Between
 * them they cover "copies what is named", "copies nothing else", and "reaches into directories".
 *
 * Fixture setup shells out with Bun's `$` — test scaffolding standing in for a human at a
 * terminal, which is why it is exempt from the executor-boundary audit.
 */

let repoDir: string;
let worktreeRoot: string;
let executor: Executor;

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "gc-setup-repo-"));
  worktreeRoot = mkdtempSync(join(tmpdir(), "gc-setup-wt-"));
  executor = createLocalExecutor(worktreeRoot);

  await $`git -C ${repoDir} init -q`.quiet();
  await $`git -C ${repoDir} config user.email t@e.com`.quiet();
  await $`git -C ${repoDir} config user.name Test`.quiet();
  writeFileSync(join(repoDir, ".gitignore"), ".env\n.env.*\nconfig/local.json\nnode_modules/\n");
  writeFileSync(join(repoDir, "README.md"), "initial\n");
  await $`git -C ${repoDir} add -A`.quiet();
  await $`git -C ${repoDir} commit -q -m init`.quiet();

  // The ignored files: present in the repository, absent from every worktree cut from it.
  writeFileSync(join(repoDir, ".env"), "DATABASE_URL=sqlite://local.db\n");
  writeFileSync(join(repoDir, ".env.test"), "DATABASE_URL=sqlite://memory\n");
  await mkdir(join(repoDir, "config"), { recursive: true });
  writeFileSync(join(repoDir, "config", "local.json"), '{"port":5000}\n');
  await mkdir(join(repoDir, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(join(repoDir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
});

afterAll(() => {
  for (const dir of [worktreeRoot, repoDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** A fresh worktree to copy into; each test gets its own so one cannot see another's files. */
async function freshWorktree(taskId: string): Promise<string> {
  const wt = await provisionWorktree(executor, {
    taskId,
    repository: { source: "local_path", location: repoDir },
    worktreeRoot,
    repoCacheRoot: worktreeRoot,
  });
  return wt.path;
}

describe("seeding a worktree with the setup-file allowlist", () => {
  it("copies the named ignored files, contents intact (AC-1)", async () => {
    const path = await freshWorktree("copies");
    expect(existsSync(join(path, ".env"))).toBe(false);

    const result = await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: [".env", "config/local.json"],
    });

    expect(result.copied).toBe(2);
    expect(result.failed).toBe(0);
    expect(readFileSync(join(path, ".env"), "utf8")).toBe("DATABASE_URL=sqlite://local.db\n");
    // A nested destination directory is created rather than assumed to exist.
    expect(readFileSync(join(path, "config", "local.json"), "utf8")).toBe('{"port":5000}\n');
  });

  it("copies only what the allowlist names, never everything git ignores (AC-2)", async () => {
    const path = await freshWorktree("allowlist");

    await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: [".env"],
    });

    // The other ignored files are exactly what "copy everything ignored" would have swept in.
    expect(existsSync(join(path, ".env"))).toBe(true);
    expect(existsSync(join(path, ".env.test"))).toBe(false);
    expect(existsSync(join(path, "config", "local.json"))).toBe(false);
    expect(existsSync(join(path, "node_modules"))).toBe(false);
  });

  it("expands a glob across the files it matches", async () => {
    const path = await freshWorktree("glob");

    const result = await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: [".env*"],
    });

    expect(result.copied).toBe(2);
    expect(existsSync(join(path, ".env"))).toBe(true);
    expect(existsSync(join(path, ".env.test"))).toBe(true);
  });

  it("copies a file matched by two patterns once", async () => {
    const path = await freshWorktree("dedup");

    const result = await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: [".env", ".env"],
    });

    expect(result.copied).toBe(1);
  });

  it("reports a pattern that matches nothing and carries on (AC-5)", async () => {
    const path = await freshWorktree("unmatched");

    const result = await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: ["absent.env", ".env"],
    });

    expect(result.unmatched).toEqual(["absent.env"]);
    expect(result.copied).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("cannot reach a file outside the repository (AC-6)", async () => {
    const path = await freshWorktree("jail");
    const outside = mkdtempSync(join(tmpdir(), "gc-outside-"));
    writeFileSync(join(outside, "secret.env"), "STOLEN=1\n");

    // These never reach `seedSetupFiles` in production — `setupFilePatternSchema` rejects them —
    // but the jail must not depend on the validator upstream of it having run.
    const result = await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: ["../*/secret.env", `${outside}/secret.env`],
    });

    expect(result.copied).toBe(0);
    expect(result.unmatched.length).toBe(2);
    expect(existsSync(join(path, "secret.env"))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it("returns counts and patterns only — never a resolved path (AC-3)", async () => {
    const path = await freshWorktree("no-paths");

    const result = await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: [".env*"],
    });

    // The only strings the result can carry are the operator's own patterns. Anything else
    // would be a filename waiting to be logged by a caller that assumed it was safe.
    const strings = JSON.stringify(result);
    expect(strings).not.toContain(".env.test");
    expect(strings).not.toContain(repoDir);
    expect(strings).not.toContain(path);
  });
});

describe("keeping copied files out of the review", () => {
  it("excludes them from the diff a reviewer sees (AC-4)", async () => {
    const path = await freshWorktree("diff");
    await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: [".env"],
    });
    // What the agent actually did, alongside the copied file.
    writeFileSync(join(path, "src.ts"), "export const latch = true;\n");

    const diff = await diffWorktree(executor, path, [".env"]);

    expect(diff.files.map((f) => f.path)).toEqual(["src.ts"]);
    expect(diff.patch).not.toContain("DATABASE_URL");
  });

  it("excludes a *tracked* file the allowlist names — the case git alone would not catch", async () => {
    const path = await freshWorktree("tracked");
    // README.md is committed, so a copy of a locally-modified one lands in the diff unless the
    // exclusion is applied. This is the case that makes the exclusion load-bearing rather than
    // a restatement of `.gitignore`.
    writeFileSync(join(repoDir, "README.md"), "locally modified\n");

    await seedSetupFiles(executor, {
      repoPath: repoDir,
      worktreePath: path,
      patterns: ["README.md"],
    });

    expect(readFileSync(join(path, "README.md"), "utf8")).toBe("locally modified\n");
    const diff = await diffWorktree(executor, path, ["README.md"]);
    expect(diff.files).toEqual([]);
    // ...and it is not counted as the agent having produced work, either.
    expect(await hasChanges(executor, path, ["README.md"])).toBe(false);
    // Nor does approving the Task commit it onto the branch (Principle IV).
    writeFileSync(join(path, "src.ts"), "export const latch = true;\n");
    await commitWorktree(executor, path, "SoloW: task tracked", ["README.md"]);
    const committed = await $`git -C ${path} show --name-only --format= HEAD`.quiet().text();
    expect(committed).toContain("src.ts");
    expect(committed).not.toContain("README.md");

    writeFileSync(join(repoDir, "README.md"), "initial\n");
  });

  it("spells the exclusion as a git pathspec", () => {
    expect(setupFileExclusions([".env", "config/*.json"])).toEqual([
      ":(exclude,glob).env",
      ":(exclude,glob)config/*.json",
    ]);
    expect(setupFileExclusions([])).toEqual([]);
  });
});
