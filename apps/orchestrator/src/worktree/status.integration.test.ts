import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createLocalExecutor } from "../executor/local.js";
import type { Executor } from "../executor/types.js";
import { readScmStatus } from "./status.js";

/**
 * Integration test: the source-control read against real git (spec F22).
 *
 * The unit tests in `status.test.ts` parse fixtures captured from git; this one closes the loop
 * by asking git itself, so a future git that changes its porcelain — or an assumption about
 * field positions that happens to hold for the fixture — fails here rather than in a panel.
 *
 * Fixture setup shells out with Bun's `$`, which is test scaffolding standing in for a human at
 * a prompt and is exempt from the executor-boundary audit, exactly as `manager.integration.test.ts`
 * already relies on.
 */

let repoDir: string;
let executor: Executor;

beforeAll(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "gc-scm-"));
  executor = createLocalExecutor(repoDir);

  await $`git -C ${repoDir} init -q -b main`.quiet();
  await $`git -C ${repoDir} config user.email t@e.com`.quiet();
  await $`git -C ${repoDir} config user.name Test`.quiet();
  // Repo-local, so a developer's own `core.excludesFile` cannot decide the outcome. This test
  // asserts that a `.env` *would* show up but for the setup-file exclusion, and this machine's
  // global ignore file lists `.env` — which would make the assertion pass for the wrong reason
  // here, or fail on a machine whose global ignore differs.
  await $`git -C ${repoDir} config core.excludesFile /dev/null`.quiet();
  await mkdir(join(repoDir, "src"), { recursive: true });
  await mkdir(join(repoDir, "old"), { recursive: true });
  writeFileSync(join(repoDir, "src/staged.ts"), "a\nb\nc\n");
  writeFileSync(join(repoDir, "src/unstaged.ts"), "x\ny\n");
  writeFileSync(join(repoDir, "src/both.ts"), "p\nq\n");
  writeFileSync(join(repoDir, "old/path.ts"), "r\n");
  writeFileSync(join(repoDir, "src/deleted.ts"), "gone\n");
  writeFileSync(join(repoDir, ".env"), "SECRET=do-not-render-me\n");
  await $`git -C ${repoDir} add -A`.quiet();
  await $`git -C ${repoDir} commit -qm init`.quiet();

  writeFileSync(join(repoDir, "src/staged.ts"), "a\nb\nc\nd\n");
  await $`git -C ${repoDir} add src/staged.ts`.quiet();
  writeFileSync(join(repoDir, "src/unstaged.ts"), "x\ny\nz\n");
  writeFileSync(join(repoDir, "src/both.ts"), "p\nq\nr\n");
  await $`git -C ${repoDir} add src/both.ts`.quiet();
  writeFileSync(join(repoDir, "src/both.ts"), "p\nq\nr\ns\n");
  await $`git -C ${repoDir} mv old/path.ts new-path.ts`.quiet();
  await $`git -C ${repoDir} rm -q src/deleted.ts`.quiet();
  writeFileSync(join(repoDir, "untracked.txt"), "hello\n");
  writeFileSync(join(repoDir, ".env"), "SECRET=changed-since-the-agent-ran\n");
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("readScmStatus against real git", () => {
  it("reports every group the way the panel renders it", async () => {
    const status = await readScmStatus(executor, repoDir, [".env"]);
    const rows = status.files.map((f) => `${f.group}:${f.letter}:${f.path}`).sort();
    expect(rows).toEqual([
      "changes:M:src/both.ts",
      "changes:M:src/unstaged.ts",
      "staged:D:src/deleted.ts",
      "staged:M:src/both.ts",
      "staged:M:src/staged.ts",
      "staged:R:new-path.ts",
      "untracked:?:untracked.txt",
    ]);
  });

  it("reads the branch git is actually on", async () => {
    const status = await readScmStatus(executor, repoDir, [".env"]);
    expect(status.branch.name).toBe("main");
    expect(status.branch.detached).toBe(false);
    expect(status.branch.head).toHaveLength(8);
    // No remote in a throwaway repo, so no upstream to be ahead or behind of.
    expect(status.branch.upstream).toBeNull();
    expect(status.branch.ahead).toBe(0);
  });

  it("carries a rename's original path and does not invent a file from it", async () => {
    const status = await readScmStatus(executor, repoDir, [".env"]);
    expect(status.files.some((f) => f.path === "old/path.ts")).toBe(false);
    expect(status.files.find((f) => f.path === "new-path.ts")?.originalPath).toBe("old/path.ts");
  });

  it("keeps a setup file out of the panel even after the agent changed it (issue #52)", async () => {
    // The `.env` was copied in for the agent and has been modified since. It is not part of what
    // the agent proposed, and putting it on screen would put a secret on screen (Principle IV).
    const status = await readScmStatus(executor, repoDir, [".env"]);
    expect(status.files.some((f) => f.path === ".env")).toBe(false);
    // ...and it *is* a change git would otherwise report, so the exclusion is doing the work.
    const unfiltered = await readScmStatus(executor, repoDir, []);
    expect(unfiltered.files.some((f) => f.path === ".env")).toBe(true);
  });

  it("counts lines per group, so a staged and re-modified file reads twice", async () => {
    const status = await readScmStatus(executor, repoDir, [".env"]);
    const both = status.files.filter((f) => f.path === "src/both.ts");
    expect(both).toHaveLength(2);
    for (const row of both) {
      expect(row.additions).toBe(1);
      expect(row.binary).toBe(false);
    }
  });
});
