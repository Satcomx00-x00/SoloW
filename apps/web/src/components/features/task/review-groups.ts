import type { TaskDiffDto, TaskRepositoryDto } from "@solow/contracts";

/**
 * What one approval is about to do, group by group (spec F10, issue #70).
 *
 * A Task spans repositories now (issue #7), so one click on Approve has several consequences at
 * once — a commit here, a branch recorded there, nothing at all in the third. The design rule
 * this file serves is **one decision, all consequences visible**: the reviewer sees every group
 * and its target *before* deciding, rather than discovering afterwards which repositories moved.
 *
 * Splitting the decision per repository would look more granular and is worse. It creates
 * partially-integrated Tasks — repository A landed, B was rejected — and nothing in the model
 * describes what that state is or how to leave it. So there is exactly one decision (AC-3), and
 * the whole job here is making its scope legible.
 *
 * A group is `(repository, branch)` and not `repository` alone (AC-1). The branch is the thing a
 * reviewer will actually fetch, two attachments of one Task can sit on different branches, and a
 * heading that named only the repository would be ambiguous exactly when it mattered.
 *
 * Pure, and separate from the panel that draws it, for the reason the hierarchy and the windowing
 * arithmetic are: this is a claim about what will happen, and a claim about what will happen
 * should be checkable without a DOM.
 */

export interface ReviewGroup {
  /** Stable across renders and unique per `(repository, branch)`. */
  key: string;
  repositoryId: string | null;
  /** The provider's name for it, or null when the change arrived without one. */
  repositoryName: string | null;
  /** The branch an approval commits to — what a reviewer fetches. */
  branch: string | null;
  /** What that branch was cut from, when the attachment recorded one. */
  baseRef: string | null;
  fileCount: number;
  /**
   * The captured change, or null for a repository the agent never touched.
   *
   * Null is not "missing data" — it is a consequence worth stating. Approving a Task still
   * records a result branch for that attachment, and a reviewer who assumed every attached
   * repository had changes would be wrong about what they just approved.
   */
  diff: TaskDiffDto | null;
}

/**
 * Every group this decision covers, in the order the attachments were given.
 *
 * Built from the **attachments** and joined to the diffs, not the other way round. A Task that
 * reached the gate having changed one of its three repositories has three consequences and one
 * diff; grouping the diffs alone would show one, and the missing two are precisely the ones a
 * reviewer would not think to ask about.
 *
 * A diff whose repository is not among the attachments is still shown — it is a change that
 * exists, and dropping it would hide part of what is being approved. That happens for a session
 * event written before multi-repository Tasks existed, which carries no `repositoryId` at all.
 */
export function groupChanges(
  diffs: readonly TaskDiffDto[],
  repositories: readonly TaskRepositoryDto[],
  nameFor: (repositoryId: string) => string | null = () => null,
): ReviewGroup[] {
  const claimed = new Set<TaskDiffDto>();
  const groups: ReviewGroup[] = [];

  for (const attachment of [...repositories].sort((a, b) => a.position - b.position)) {
    // Matched on the repository, then on the branch when the attachment names one it landed on:
    // a repository attached twice on two branches is legal, and matching on the repository alone
    // would give both attachments the same diff.
    const branchOf = attachment.resultBranch ?? attachment.checkoutBranch;
    const diff =
      diffs.find(
        (d) =>
          !claimed.has(d) &&
          d.repositoryId === attachment.repositoryId &&
          (attachment.resultBranch === null || d.diffRef === attachment.resultBranch),
      ) ??
      /*
       * A change that names no repository, on this attachment's own branch.
       *
       * A `diff` event written before multi-repository Tasks existed carries no `repositoryId`,
       * and without this fallback it becomes an orphan group *beside* an attachment group
       * claiming "no changes" — two rows describing one change, one of them false. The branch is
       * enough to join on: it is unique per worktree, which is what a group is.
       */
      diffs.find(
        (d) => !claimed.has(d) && d.repositoryId === undefined && d.diffRef === branchOf,
      ) ??
      null;
    if (diff) claimed.add(diff);
    const branch = diff?.diffRef ?? branchOf;
    groups.push({
      key: `${attachment.repositoryId}:${branch}`,
      repositoryId: attachment.repositoryId,
      repositoryName: diff?.repositoryName ?? nameFor(attachment.repositoryId),
      branch,
      baseRef: attachment.baseRef,
      fileCount: diff?.files.length ?? 0,
      diff,
    });
  }

  for (const diff of diffs) {
    if (claimed.has(diff)) continue;
    groups.push({
      key: `${diff.repositoryId ?? "unattached"}:${diff.diffRef}`,
      repositoryId: diff.repositoryId ?? null,
      repositoryName: diff.repositoryName ?? null,
      branch: diff.diffRef,
      baseRef: null,
      fileCount: diff.files.length,
      diff,
    });
  }

  return groups;
}

/**
 * The one-line consequence summary that sits above the decision (AC-2).
 *
 * Counted rather than listed, because the list is already on screen: this is the sentence that
 * makes the *scope* of the click obvious at a glance — "2 repositories, 2 branches, 14 files" —
 * for the reviewer who is about to approve without scrolling.
 *
 * There is deliberately no "1 pull request" clause. Opening one is issue #71's integration
 * strategy and this build does not do it, so promising it here would state a consequence that
 * will not happen — the exact failure this summary exists to prevent, pointed the other way.
 */
export function summariseConsequences(groups: readonly ReviewGroup[]): string {
  if (groups.length === 0) return "Nothing to integrate — the agent proposed no changes.";

  const repositories = new Set(groups.map((g) => g.repositoryId ?? g.key)).size;
  const branches = new Set(groups.map((g) => g.branch).filter((b): b is string => b !== null)).size;
  const files = groups.reduce((total, group) => total + group.fileCount, 0);
  const untouched = groups.filter((group) => group.diff === null).length;

  const parts = [
    count(repositories, "repository", "repositories"),
    count(branches, "branch", "branches"),
    count(files, "file", "files"),
  ];
  // Named rather than folded into the file count: "3 repositories, 12 files" reads as though all
  // three changed. The reviewer's question is which ones did.
  if (untouched > 0) parts.push(`${untouched} with no changes`);
  return parts.join(", ");
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What approving this group does, in a sentence (AC-2).
 *
 * Stated per group rather than once for the Task, because the answer genuinely differs: a
 * repository the agent never touched gets a branch recorded and no commit, and that is a
 * different consequence from the one beside it.
 */
export function describeTarget(group: ReviewGroup, captured = true): string {
  const branch = group.branch ?? "an unnamed branch";
  const base = group.baseRef ? ` (from ${group.baseRef})` : "";
  if (group.diff !== null)
    return `Commits ${count(group.fileCount, "file", "files")} to ${branch}${base}.`;
  /*
   * "Not looked at yet" and "looked at, nothing there" are different facts, and this used to
   * render them identically.
   *
   * A change is captured once, when the run reaches its review gate — so for the whole of a run,
   * and for a Task that has never run at all, every group legitimately has no diff. Saying "no
   * changes" there is a claim nobody has checked, and it was on screen while the agent was
   * visibly editing files: the panel read "The agent made no changes in this repository" beside
   * a transcript of it changing them.
   *
   * The same sentence is also a promise about what an approval will do, which is premature on a
   * Task sitting in Backlog. So neither is said until there is something to say it about.
   */
  if (!captured) return `Nothing captured yet — the change is read when the run reaches review.`;
  return `No changes — records ${branch}${base} without committing.`;
}
