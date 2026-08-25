import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createLocalExecutor } from "../executor/local.js";
import type { Executor } from "../executor/types.js";
import {
  assertContained,
  discardPaths,
  PathRefusedError,
  stagePaths,
  unstagePaths,
} from "./scm-ops.js";
import { readScmStatus } from "./status.js";

/**
 * The write half of the source-control panel, against real git (spec F22).
 *
 * The containment tests here build the escape rather than asserting on a string: a path guard
 * that is only tested with `"../etc/passwd"` proves the guard rejects that literal, not that a
 * symlink cannot be used to read outside the worktree. Both are attempted below.
 */

const roots: string[] = [];
let repoDir: string;
let outsideDir: string;
let executor: Executor;

function group(status: Awaited<ReturnType<typeof readScmStatus>>, path: string): string[] {
  return status.files.filter((f) => f.path === path).map((f) => f.group);
}

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "gc-ops-"));
  outsideDir = mkdtempSync(join(tmpdir(), "gc-outside-"));
  roots.push(repoDir, outsideDir);
  executor = createLocalExecutor(repoDir);

  await $`git -C ${repoDir} init -q -b main`.quiet();
  await $`git -C ${repoDir} config user.email t@e.com`.quiet();
  await $`git -C ${repoDir} config user.name Test`.quiet();
  await $`git -C ${repoDir} config core.excludesFile /dev/null`.quiet();
  writeFileSync(join(repoDir, "tracked.txt"), "original\n");
  await $`git -C ${repoDir} add -A`.quiet();
  await $`git -C ${repoDir} commit -qm init`.quiet();

  writeFileSync(join(repoDir, "tracked.txt"), "edited by the agent\n");
  writeFileSync(join(repoDir, "new.txt"), "created by the agent\n");
  writeFileSync(join(outsideDir, "secret.txt"), "not the agent's to touch\n");
});

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("staging is the review selection", () => {
  it("moves a file into the staged group and leaves the others alone", async () => {
    await stagePaths(executor, repoDir, ["tracked.txt"]);

    const status = await readScmStatus(executor, repoDir);
    expect(group(status, "tracked.txt")).toEqual(["staged"]);
    expect(group(status, "new.txt")).toEqual(["untracked"]);
  });

  it("stages an untracked file, which is how a new file joins the selection", async () => {
    await stagePaths(executor, repoDir, ["new.txt"]);

    expect(group(await readScmStatus(executor, repoDir), "new.txt")).toEqual(["staged"]);
  });

  it("unstaging takes it out of the selection without touching the work", async () => {
    // The mis-click case. "Not this time" must never mean "throw it away".
    await stagePaths(executor, repoDir, ["tracked.txt"]);
    await unstagePaths(executor, repoDir, ["tracked.txt"]);

    expect(group(await readScmStatus(executor, repoDir), "tracked.txt")).toEqual(["changes"]);
    expect(readFileSync(join(repoDir, "tracked.txt"), "utf8")).toBe("edited by the agent\n");
  });
});

describe("discard", () => {
  it("reverts a tracked file to HEAD, index and working tree together", async () => {
    await stagePaths(executor, repoDir, ["tracked.txt"]);
    await discardPaths(executor, repoDir, ["tracked.txt"]);

    expect(readFileSync(join(repoDir, "tracked.txt"), "utf8")).toBe("original\n");
    expect(group(await readScmStatus(executor, repoDir), "tracked.txt")).toEqual([]);
  });

  it("deletes an untracked file, because there is no commit to revert it to", async () => {
    await discardPaths(executor, repoDir, ["new.txt"]);

    expect(existsSync(join(repoDir, "new.txt"))).toBe(false);
  });

  it("handles a mixed selection in one call", async () => {
    await discardPaths(executor, repoDir, ["tracked.txt", "new.txt"]);

    expect(readFileSync(join(repoDir, "tracked.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(repoDir, "new.txt"))).toBe(false);
  });
});

describe("path containment (F22 NFR-3, AC-9)", () => {
  it("refuses an absolute path", () => {
    expect(() => assertContained("/etc/passwd")).toThrow(PathRefusedError);
  });

  it("refuses traversal that only appears after normalisation", () => {
    // `a/../../b` is not obviously an escape until the segments collapse, which is why the
    // guard normalises before it decides.
    expect(() => assertContained("a/../../b")).toThrow(PathRefusedError);
    expect(() => assertContained("../secret.txt")).toThrow(PathRefusedError);
  });

  it("refuses a path that would be read as a flag", () => {
    expect(() => assertContained("--exec=rm -rf /")).toThrow(PathRefusedError);
  });

  it("allows an ordinary nested path", () => {
    expect(assertContained("src/a/b.ts")).toBe("src/a/b.ts");
    // `./` is noise, not an escape.
    expect(assertContained("./src/a.ts")).toBe("src/a.ts");
  });

  it("cannot be used to stage a file outside the worktree through a symlink", async () => {
    // The escape a lexical guard cannot see. What saves us is git: `add` stages the *link*,
    // recording its target as the file's content, and never reads the file it points at.
    symlinkSync(join(outsideDir, "secret.txt"), join(repoDir, "escape.txt"));

    await stagePaths(executor, repoDir, ["escape.txt"]);

    const staged = await executor.exec(["git", "-C", repoDir, "show", ":escape.txt"]);
    expect(staged.stdout).toBe(join(outsideDir, "secret.txt"));
    expect(staged.stdout).not.toContain("not the agent's to touch");
  });

  it("cannot be used to delete a file outside the worktree through a symlink", async () => {
    symlinkSync(join(outsideDir, "secret.txt"), join(repoDir, "escape.txt"));

    await discardPaths(executor, repoDir, ["escape.txt"]);

    // The link is gone; what it pointed at is untouched.
    expect(existsSync(join(repoDir, "escape.txt"))).toBe(false);
    expect(readFileSync(join(outsideDir, "secret.txt"), "utf8")).toBe("not the agent's to touch\n");
  });

  it("refuses the whole call when any one path is refused", async () => {
    // Fail closed: a batch is not a place to quietly drop the one entry that looked wrong.
    expect(stagePaths(executor, repoDir, ["tracked.txt", "../escape"])).rejects.toThrow(
      PathRefusedError,
    );
    expect(group(await readScmStatus(executor, repoDir), "tracked.txt")).toEqual(["changes"]);
  });
});
