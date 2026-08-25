/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ScmFileDto } from "@gatecontrol/contracts";
import { buildScmTree, splitPath } from "./source-control-tree";

const file = (path: string): ScmFileDto => ({
  path,
  group: "changes",
  kind: "modified",
  letter: "M",
  additions: 1,
  deletions: 0,
  binary: false,
});

/** Flatten to `dir/` and `file` labels, depth-first, for readable assertions. */
function shape(nodes: ReturnType<typeof buildScmTree>, depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === "directory"
      ? [`${"  ".repeat(depth)}${node.label}/`, ...shape(node.children, depth + 1)]
      : [`${"  ".repeat(depth)}${splitPath(node.path).name}`],
  );
}

describe("buildScmTree", () => {
  it("nests files under the directories that hold them", () => {
    expect(shape(buildScmTree([file("src/a.ts"), file("src/b.ts"), file("README.md")]))).toEqual([
      "src/",
      "  a.ts",
      "  b.ts",
      "README.md",
    ]);
  });

  it("collapses a chain of single-child directories into one row", () => {
    // Three rows each containing only the next is a staircase, not a tree.
    expect(shape(buildScmTree([file("apps/web/src/app.tsx")]))).toEqual([
      "apps/web/src/",
      "  app.tsx",
    ]);
  });

  it("stops collapsing where the chain branches", () => {
    expect(shape(buildScmTree([file("a/b/c.ts"), file("a/d/e.ts")]))).toEqual([
      "a/",
      "  b/",
      "    c.ts",
      "  d/",
      "    e.ts",
    ]);
  });

  it("does not collapse a directory that holds a file of its own", () => {
    expect(shape(buildScmTree([file("a/keep.ts"), file("a/b/deep.ts")]))).toEqual([
      "a/",
      "  b/",
      "    deep.ts",
      "  keep.ts",
    ]);
  });

  it("puts directories before files and sorts each case-insensitively", () => {
    const nodes = buildScmTree([file("zebra.ts"), file("Apple.ts"), file("dir/x.ts")]);
    expect(shape(nodes)).toEqual(["dir/", "  x.ts", "Apple.ts", "zebra.ts"]);
  });

  it("handles a file at the root with no directory at all", () => {
    expect(shape(buildScmTree([file("LICENSE")]))).toEqual(["LICENSE"]);
  });

  it("returns nothing for an empty group", () => {
    expect(buildScmTree([])).toEqual([]);
  });
});

describe("splitPath", () => {
  it("separates the name a row shows from the parent it dims", () => {
    expect(splitPath("src/features/a.ts")).toEqual({ name: "a.ts", parent: "src/features" });
  });

  it("leaves a root-level file with no parent", () => {
    expect(splitPath("LICENSE")).toEqual({ name: "LICENSE", parent: "" });
  });
});
