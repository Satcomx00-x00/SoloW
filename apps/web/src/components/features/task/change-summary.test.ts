import { describe, expect, it } from "bun:test";
import { formatDelta, summariseDiff } from "./change-summary";

/**
 * The facts a reviewer wants pointed out rather than found. Each flag is a claim about the diff,
 * so each is pinned as one: a deletion is flagged by status, a lockfile by basename wherever it
 * sits, truncation by the capture's own word for it.
 */
describe("summariseDiff", () => {
  const diff = {
    truncated: false,
    files: [
      { path: "src/latch.ts", status: "modified" as const, additions: 30, deletions: 8 },
      { path: "src/old-latch.ts", status: "deleted" as const, additions: 0, deletions: 120 },
      { path: "apps/web/bun.lock", status: "modified" as const, additions: 300, deletions: 0 },
      { path: "docs/latch.md", status: "added" as const, additions: 10, deletions: 0 },
    ],
  };

  it("adds the deltas up, which nothing on the page did", () => {
    const summary = summariseDiff(diff);
    expect(summary.files).toBe(4);
    expect(summary.additions).toBe(340);
    expect(summary.deletions).toBe(128);
    expect(formatDelta(summary)).toBe("+340 −128");
  });

  it("names the deletions and the lockfiles, by path", () => {
    const summary = summariseDiff(diff);
    expect(summary.deleted).toEqual(["src/old-latch.ts"]);
    // Matched on the basename: a lockfile inside a workspace package still counts.
    expect(summary.lockfiles).toEqual(["apps/web/bun.lock"]);
  });

  it("carries the capture's truncation through untouched", () => {
    expect(summariseDiff({ ...diff, truncated: true }).truncated).toBe(true);
    expect(summariseDiff({ files: [], truncated: false })).toEqual({
      files: 0,
      additions: 0,
      deletions: 0,
      deleted: [],
      lockfiles: [],
      truncated: false,
    });
  });
});
