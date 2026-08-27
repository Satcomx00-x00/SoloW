/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { TaskDiffDto, TaskRepositoryDto } from "@solow/contracts";
import { describeTarget, groupChanges, summariseConsequences } from "./review-groups";

/**
 * What one approval is about to do (spec F10, issue #70).
 *
 * The design rule under test is **one decision, all consequences visible**. The failure it guards
 * against is quiet: a Task attached to three repositories reaches the gate having changed one, the
 * reviewer sees one group, approves, and two branches they never saw are recorded. Every case
 * below is a shape of that — a repository with no diff, a diff with no repository, two attachments
 * of one repository on different branches.
 */

const attachment = (over: Partial<TaskRepositoryDto> & Pick<TaskRepositoryDto, "repositoryId">) =>
  ({
    id: `att-${over.repositoryId}`,
    baseRef: "main",
    checkoutBranch: `solow/${over.repositoryId}`,
    resultBranch: null,
    position: 0,
    ...over,
  }) as TaskRepositoryDto;

const diff = (over: Partial<TaskDiffDto> & Pick<TaskDiffDto, "diffRef">): TaskDiffDto => ({
  files: [{ path: "src/a.ts", additions: 1, deletions: 0, status: "modified" }],
  patch: "diff --git a/src/a.ts b/src/a.ts",
  truncated: false,
  ...over,
});

describe("groupChanges", () => {
  it("groups by (repository, branch), not by repository alone", () => {
    // Two attachments of one repository on two branches is legal, and a heading naming only the
    // repository would be ambiguous exactly where it matters.
    const groups = groupChanges(
      [
        diff({ diffRef: "feat/a", repositoryId: "repo-1", repositoryName: "api" }),
        diff({ diffRef: "feat/b", repositoryId: "repo-1", repositoryName: "api" }),
      ],
      [
        attachment({ repositoryId: "repo-1", resultBranch: "feat/a", position: 0 }),
        attachment({ repositoryId: "repo-1", resultBranch: "feat/b", position: 1 }),
      ],
    );

    expect(groups.map((g) => g.branch)).toEqual(["feat/a", "feat/b"]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  });

  it("shows an attached repository the agent never touched, rather than omitting it", () => {
    // The defect this file exists for. Approving still records a branch for that attachment, so
    // a reviewer who saw only the changed repository was wrong about what they approved.
    const groups = groupChanges(
      [diff({ diffRef: "solow/repo-1", repositoryId: "repo-1", repositoryName: "api" })],
      [
        attachment({ repositoryId: "repo-1", position: 0 }),
        attachment({ repositoryId: "repo-2", position: 1 }),
      ],
      (id) => (id === "repo-2" ? "web" : null),
    );

    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({
      repositoryId: "repo-2",
      repositoryName: "web",
      branch: "solow/repo-2",
      fileCount: 0,
      diff: null,
    });
  });

  it("keeps a change whose repository is not among the attachments", () => {
    // A `diff` event written before multi-repository Tasks existed carries no repository id at
    // all. It is still a change being approved, and dropping it would hide part of the decision.
    const groups = groupChanges([diff({ diffRef: "legacy-branch" })], []);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ repositoryId: null, branch: "legacy-branch" });
  });

  it("joins a change that names no repository to the attachment on its branch", () => {
    // Without this, an event written by an older build becomes an orphan group *beside* an
    // attachment group claiming "no changes" — two rows describing one change, one of them false.
    const groups = groupChanges(
      [diff({ diffRef: "solow/repo-1" })],
      [attachment({ repositoryId: "repo-1" })],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.fileCount).toBe(1);
  });

  it("orders the groups the way the attachments were given", () => {
    // Position 0 is the worktree the agent was started in — the primary — and a reviewer reads
    // the list expecting it first.
    const groups = groupChanges(
      [],
      [
        attachment({ repositoryId: "repo-b", position: 1 }),
        attachment({ repositoryId: "repo-a", position: 0 }),
      ],
    );

    expect(groups.map((g) => g.repositoryId)).toEqual(["repo-a", "repo-b"]);
  });

  it("gives one diff to one group, never to two", () => {
    const groups = groupChanges(
      [diff({ diffRef: "solow/repo-1", repositoryId: "repo-1" })],
      [
        attachment({ repositoryId: "repo-1", position: 0 }),
        attachment({ repositoryId: "repo-1", position: 1, checkoutBranch: "other" }),
      ],
    );

    expect(groups.filter((g) => g.diff !== null)).toHaveLength(1);
  });
});

describe("summariseConsequences", () => {
  it("counts what the click is about to do", () => {
    const groups = groupChanges(
      [
        diff({ diffRef: "b1", repositoryId: "repo-1" }),
        diff({
          diffRef: "b2",
          repositoryId: "repo-2",
          files: [
            { path: "a", additions: 1, deletions: 0, status: "added" },
            { path: "b", additions: 0, deletions: 1, status: "deleted" },
          ],
        }),
      ],
      [
        attachment({ repositoryId: "repo-1", resultBranch: "b1", position: 0 }),
        attachment({ repositoryId: "repo-2", resultBranch: "b2", position: 1 }),
      ],
    );

    expect(summariseConsequences(groups)).toBe("2 repositories, 2 branches, 3 files");
  });

  it("names the repositories with nothing in them instead of folding them into a file count", () => {
    // "3 repositories, 1 file" reads as though all three changed. Which ones did is the
    // reviewer's actual question.
    const groups = groupChanges(
      [diff({ diffRef: "b1", repositoryId: "repo-1" })],
      [
        attachment({ repositoryId: "repo-1", resultBranch: "b1", position: 0 }),
        attachment({ repositoryId: "repo-2", position: 1 }),
      ],
    );

    expect(summariseConsequences(groups)).toContain("1 with no changes");
  });

  it("says so plainly when there is nothing to integrate", () => {
    expect(summariseConsequences([])).toBe("Nothing to integrate — the agent proposed no changes.");
  });

  it("promises no pull request, because this build opens none", () => {
    // Issue #71's integration strategies are what would open one. Stating it here would be the
    // failure this summary exists to prevent, pointed the other way.
    const groups = groupChanges([diff({ diffRef: "b1", repositoryId: "repo-1" })], []);

    expect(summariseConsequences(groups).toLowerCase()).not.toContain("pull request");
  });
});

describe("describeTarget", () => {
  it("states the branch and what it was cut from", () => {
    const [group] = groupChanges(
      [diff({ diffRef: "feat/a", repositoryId: "repo-1" })],
      [attachment({ repositoryId: "repo-1", resultBranch: "feat/a", baseRef: "develop" })],
    );

    expect(group && describeTarget(group)).toBe("Commits 1 file to feat/a (from develop).");
  });

  it("says a repository with no changes is recorded, not committed", () => {
    const [group] = groupChanges([], [attachment({ repositoryId: "repo-2", baseRef: "main" })]);

    expect(group && describeTarget(group)).toBe(
      "No changes — records solow/repo-2 (from main) without committing.",
    );
  });
});

describe("describeTarget before anything has been captured", () => {
  /**
   * "Not looked at yet" and "looked at, nothing there" are different facts.
   *
   * A change is read once, when the run reaches its review gate. So for the whole of a run — and
   * on a Task that has never run — every group legitimately has no diff, and the panel used to
   * say "No changes" about all of them. It was on screen while the agent was visibly editing
   * files: the Changes column claimed nothing had changed beside a transcript of it changing
   * things.
   */
  it("says the change has not been read yet, rather than that there is none", () => {
    const [group] = groupChanges([], [attachment({ repositoryId: "repo-1" })]);

    expect(group && describeTarget(group, false)).toBe(
      "Nothing captured yet — the change is read when the run reaches review.",
    );
  });

  it("still says 'no changes' once the run has looked and found none", () => {
    const [group] = groupChanges([], [attachment({ repositoryId: "repo-2", baseRef: "main" })]);

    expect(group && describeTarget(group, true)).toContain("No changes");
  });

  it("is unaffected for a group that has a change either way", () => {
    // A captured diff is proof the run looked, so the flag cannot make this sentence wrong.
    const [group] = groupChanges(
      [diff({ diffRef: "feat/a", repositoryId: "repo-1" })],
      [attachment({ repositoryId: "repo-1", resultBranch: "feat/a", baseRef: "main" })],
    );

    expect(group && describeTarget(group, false)).toBe("Commits 1 file to feat/a (from main).");
  });
});
