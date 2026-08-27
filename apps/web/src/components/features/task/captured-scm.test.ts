/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { TaskDiffDto } from "@solow/contracts";
import { scmFromCapturedDiff, splitPatchByFile } from "./captured-scm";

/**
 * The patch below is a real capture from this repository, mnemonic prefixes and all — the exact
 * thing a hand-written `a/`…`b/` fixture would have hidden.
 */
const REAL_PATCH = `diff --git c/requierements.txt w/requierements.txt
index b94897d..19f5aff 100644
--- c/requierements.txt
+++ w/requierements.txt
@@ -1,8 +1,8 @@
 logging
-tradingview-ta
+tradingview-ta==3.3.0
 statistics`;

const diff = (over: Partial<TaskDiffDto> = {}): TaskDiffDto => ({
  diffRef: "worktree-solow-task-83b3a0d4",
  files: [{ path: "requierements.txt", status: "modified", additions: 5, deletions: 5 }],
  patch: REAL_PATCH,
  truncated: false,
  ...over,
});

describe("scmFromCapturedDiff", () => {
  it("renders the capture as the panel's own rows", () => {
    const worktree = scmFromCapturedDiff(diff(), "captured");

    expect(worktree.files).toEqual([
      {
        path: "requierements.txt",
        group: "changes",
        kind: "modified",
        letter: "M",
        additions: 5,
        deletions: 5,
        binary: false,
      },
    ]);
    expect(worktree.branch.name).toBe("worktree-solow-task-83b3a0d4");
  });

  it("is never writable, because there is no working tree behind it", () => {
    const worktree = scmFromCapturedDiff(diff(), "the worktree was cleaned up");

    expect(worktree.writable).toBe(false);
    expect(worktree.readOnlyReason).toBe("the worktree was cleaned up");
  });

  it("maps each status to the letter git would print", () => {
    const worktree = scmFromCapturedDiff(
      diff({
        files: [
          { path: "a.ts", status: "added", additions: 1, deletions: 0 },
          { path: "d.ts", status: "deleted", additions: 0, deletions: 9 },
          { path: "r.ts", status: "renamed", additions: 0, deletions: 0 },
        ],
      }),
      "captured",
    );

    expect(worktree.files.map((f) => f.letter)).toEqual(["A", "D", "R"]);
  });

  it("never claims truncation: a capture's file list is always complete", () => {
    expect(scmFromCapturedDiff(diff({ truncated: true }), "captured").truncated).toBe(false);
  });
});

describe("splitPatchByFile", () => {
  it("finds a file's section behind mnemonic prefixes", () => {
    // `diff.mnemonicPrefix` writes `c/` and `w/`, not `a/` and `b/`. Assuming the latter would
    // match nothing and show every file an empty diff.
    const sections = splitPatchByFile(REAL_PATCH, ["requierements.txt"]);

    expect(sections.get("requierements.txt")).toContain("+tradingview-ta==3.3.0");
    expect(sections.get("requierements.txt")).toStartWith("diff --git");
  });

  it("splits a multi-file patch into one section each", () => {
    const patch = [
      "diff --git a/src/one.ts b/src/one.ts",
      "@@ -1 +1 @@",
      "-one",
      "+ONE",
      "diff --git a/src/two.ts b/src/two.ts",
      "@@ -1 +1 @@",
      "-two",
      "+TWO",
    ].join("\n");

    const sections = splitPatchByFile(patch, ["src/one.ts", "src/two.ts"]);

    expect(sections.get("src/one.ts")).toContain("+ONE");
    expect(sections.get("src/one.ts")).not.toContain("+TWO");
    expect(sections.get("src/two.ts")).toContain("+TWO");
  });

  it("prefers the longest matching path, so a nested file is not claimed by its basename", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "+root",
      "diff --git a/src/a.ts b/src/a.ts",
      "+nested",
    ].join("\n");

    const sections = splitPatchByFile(patch, ["a.ts", "src/a.ts"]);

    expect(sections.get("a.ts")).toContain("+root");
    expect(sections.get("src/a.ts")).toContain("+nested");
  });

  it("returns nothing for an empty patch rather than an empty section", () => {
    expect(splitPatchByFile("", ["a.ts"]).size).toBe(0);
  });
});
