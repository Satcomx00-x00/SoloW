/**
 * The provider's issue hierarchy, made renderable (spec F23 FR-7, issue #127).
 *
 * Pure, and deliberately so: nesting, the cycle refusal and the rollup are the three things that
 * decide whether a planning table is readable or wrong, and none of them should need a database
 * or a DOM to be proven. The same reasoning as the dependency graph in `task.ts` — every question
 * about the *shape* of a graph is answered here, once, where a test can reach it.
 *
 * The hierarchy is the provider's. SoloW reads whichever one exists — GitHub's sub-issues,
 * GitLab's epics and parent links — and never invents an edge of its own (F23, States & rules),
 * which is why nothing in this file constructs a parent: it only interprets what was reported.
 *
 * One rule runs through all of it: **the answer is a function of the graph, never of the order it
 * arrived in.** A provider is free to page its response differently on the next poll, and a table
 * whose nesting changed because of that would be reporting our reading order as the team's plan.
 * Sibling and root *order* is the provider's and is kept; which row is under which is not.
 */

/**
 * One row, as the hierarchy sees it.
 *
 * `externalId` and `parentExternalId` are the **provider's** ids rather than local ones, because
 * that is what a provider reports and what the mirror stores. Resolving a parent to a row is this
 * module's job, and it is not a lookup: a parent may be in another repository, absent from the
 * project entirely, or ambiguous.
 */
export interface ProjectHierarchyRow {
  /** The row's own identity — a project item id. What nesting and collapsing are keyed on. */
  id: string;
  /** The provider's id for the issue this row projects. Null for a row with no provider behind it. */
  externalId: string | null;
  /** The provider's id of the parent issue. Null when the provider reports no parent. */
  parentExternalId: string | null;
  /**
   * Which Repository the issue came from — a tie-break, not a filter.
   *
   * GitLab's issue `iid` restarts at 1 per project, so two rows in one project can carry the same
   * `externalId` and mean two different issues (the same fact `issue_repository_external` exists
   * for). A parent is therefore matched inside its own repository first.
   */
  repositoryId: string | null;
  /**
   * Closed **on the provider** (AC-3).
   *
   * Not "a Status field says Done": a status column is a team's convention and can be renamed,
   * reordered or left behind by whoever moved the issue on GitHub instead. Closed is a fact, and
   * it is the only thing a progress number can honestly be counted from.
   */
  closed: boolean;
}

/** Completion over a row's descendants. `percent` is carried so two callers cannot round it differently. */
export interface ProjectRollup {
  done: number;
  total: number;
  percent: number;
}

export interface ProjectTreeNode<T extends ProjectHierarchyRow> {
  row: T;
  /** 0 for a top-level row. The renderer's indent, and nothing else. */
  depth: number;
  children: ProjectTreeNode<T>[];
  /**
   * Null for a row with no children — a leaf has no progress, and `0/0 · 0%` on every ordinary
   * issue would read as "none of this is done" on rows that were never an epic.
   */
  rollup: ProjectRollup | null;
  /**
   * The provider's parent chain from this row comes back to this row (AC-6).
   *
   * Always a top-level node when true, together with every other row on the same loop — see
   * `resolveParentIds`. Carried out to the renderer rather than kept private here because a
   * refusal nobody can see is indistinguishable from a project that simply has no hierarchy at
   * this row, and the reader would be trusting a shape the provider never asserted.
   */
  inCycle: boolean;
}

/**
 * Which row is this row's parent, if any.
 *
 * Three answers, in order, and the third is the one that matters:
 *
 *  1. Exactly one candidate in the **same repository** — the unambiguous case, and the only one
 *     GitLab's per-project ids can be trusted in.
 *  2. Exactly one candidate anywhere — how a cross-repository child finds its epic on a provider
 *     whose ids are global (AC-4). The child is somewhere else; the edge still holds.
 *  3. Several candidates, or none at all — **no parent**. Guessing which repository's `#12` is
 *     the epic would nest a row under a stranger, which is worse than rendering it at the top
 *     level (AC-5); and a parent outside the project is not a parent this table can draw.
 *
 * "Exactly one", not "the first one found": picking a winner out of several would make the
 * nesting depend on the order the provider happened to list its items in, so the same project
 * would draw two different shapes on two polls with no data change behind it.
 *
 * A candidate that *is* the row is returned like any other. A provider claiming an issue is its
 * own parent has reported a one-row loop, and it is refused where every other loop is rather
 * than quietly here — one refusal, one place, one thing the reader is told.
 */
function matchParent<T extends ProjectHierarchyRow>(
  row: T,
  byExternalId: ReadonlyMap<string, T[]>,
): string | null {
  if (!row.parentExternalId) return null;
  const candidates = byExternalId.get(row.parentExternalId) ?? [];
  const sameRepo = candidates.filter(
    (c) => c.repositoryId !== null && c.repositoryId === row.repositoryId,
  );
  if (sameRepo.length > 0) return sameRepo.length === 1 ? (sameRepo[0]?.id ?? null) : null;
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
}

/** The edges that survived, and the rows whose edge was refused for looping. */
interface ResolvedParents {
  /** Child id → parent id. A forest: every chain in here ends at a row with no parent. */
  parentOf: Map<string, string>;
  /** Every row the provider's hierarchy loops through. None of them appears in `parentOf`. */
  inCycle: Set<string>;
}

/**
 * The reported edges, with every cycle **refused** — so what comes back is a forest.
 *
 * A provider can hand back a cycle: GitHub's sub-issue API has shipped one, and a GitLab work
 * item's parent is editable by two people at once. A renderer that trusts such a hierarchy
 * recurses until the stack ends (AC-6). Refused **on read**, not only on write: nothing here
 * writes an edge at all, so read is the only place the refusal can happen.
 *
 * Refused means *every* row on the loop loses its parent and renders at the top level, flagged.
 * The tempting cheaper fix — drop only the single edge that closes the loop — is what this
 * function used to do, and it was wrong twice over:
 *
 *  - It renders the survivors as an ordinary nesting, indistinguishable from a hierarchy the
 *    provider actually asserted, progress badge and all. AC-6 says refuse; that quietly accepts.
 *  - *Which* edge closes the loop is whichever the walk happened to reach last, which is the
 *    provider's response order. Reorder the response and the same three issues invert — B on top
 *    instead of A — with nothing in the data changed. Cycle membership, unlike a closing edge,
 *    is a property of the graph alone, which is what makes this answer stable.
 *
 * Rows *below* a loop keep their edges: they hang off a member, they are not part of the
 * contradiction, and unparenting them would scatter work that nests perfectly well.
 *
 * `settled` keeps the walk linear rather than quadratic: a row whose chain has already been
 * followed cannot teach a second walk anything, so the second walk stops there instead of
 * re-climbing (F23 NFR-1 — a thousand items is the normal case, not the stress case).
 */
function resolveParentIds<T extends ProjectHierarchyRow>(rows: readonly T[]): ResolvedParents {
  const byExternalId = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.externalId) continue;
    const bucket = byExternalId.get(row.externalId);
    if (bucket) bucket.push(row);
    else byExternalId.set(row.externalId, [row]);
  }

  const parentOf = new Map<string, string>();
  for (const row of rows) {
    const parentId = matchParent(row, byExternalId);
    // Only rows that are actually in the project become edges: a parent nothing matched is left
    // out of the map entirely, which is what makes its child a root.
    if (parentId) parentOf.set(row.id, parentId);
  }

  const inCycle = new Set<string>();
  const settled = new Set<string>();
  for (const row of rows) {
    const path: string[] = [];
    const positionInPath = new Map<string, number>();
    let at: string | undefined = row.id;
    while (at !== undefined && !settled.has(at)) {
      const reEntered = positionInPath.get(at);
      if (reEntered !== undefined) {
        // The loop is the tail of the path, from where the chain re-entered itself. Anything
        // before that point is a row that merely climbed into the loop from underneath.
        for (let i = reEntered; i < path.length; i++) {
          const id = path[i];
          if (id) inCycle.add(id);
        }
        break;
      }
      positionInPath.set(at, path.length);
      path.push(at);
      at = parentOf.get(at);
    }
    for (const id of path) settled.add(id);
  }

  for (const id of inCycle) parentOf.delete(id);

  return { parentOf, inCycle };
}

/**
 * The rows as a forest, with each node's depth and rollup already computed.
 *
 * Input order is kept, both between siblings and between roots: it is the provider's order (or
 * the operator's, through `position`), and re-sorting it would be the table overruling the
 * project — the same rule grouping already follows. Which row is *under* which, in contrast, is
 * decided by the graph alone and does not move when the input is reordered.
 *
 * Every input row appears exactly once in the result. That is the invariant worth stating: a
 * child is nested under its parent *or* rendered at the top level, and there is no third case
 * where it is neither.
 */
export function buildProjectHierarchy<T extends ProjectHierarchyRow>(
  rows: readonly T[],
): ProjectTreeNode<T>[] {
  const { parentOf, inCycle } = resolveParentIds(rows);

  const nodes = new Map<string, ProjectTreeNode<T>>();
  for (const row of rows) {
    if (!nodes.has(row.id)) {
      nodes.set(row.id, {
        row,
        depth: 0,
        children: [],
        rollup: null,
        inCycle: inCycle.has(row.id),
      });
    }
  }

  const roots: ProjectTreeNode<T>[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id);
    // Two rows sharing an id is a caller's bug, not a hierarchy: the first wins and the second is
    // skipped, so the table shows one row too few rather than the same row twice in two places.
    if (!node || node.row !== row) continue;
    const parentId = parentOf.get(row.id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Depth and rollup, walked with an explicit stack rather than recursion — the same reason
  // `findDependencyPath` uses one: the depth of this graph is the provider's data, not ours, and
  // a deep-but-legal hierarchy must not become a stack overflow.
  const preOrder: ProjectTreeNode<T>[] = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    preOrder.push(node);
    for (const child of node.children) {
      child.depth = node.depth + 1;
      stack.push(child);
    }
  }

  // Backwards through a pre-order is a post-order: every child is reached before its parent, so
  // a parent's rollup can simply read the answers below it.
  for (let i = preOrder.length - 1; i >= 0; i--) {
    const node = preOrder[i];
    if (!node || node.children.length === 0) continue;
    let done = 0;
    let total = 0;
    for (const child of node.children) {
      // Descendants, not just direct children: an epic holding one sub-epic with five open
      // issues under it is not 1/1 · 100% done, and a number that says so is the number someone
      // reports upwards.
      total += 1 + (child.rollup?.total ?? 0);
      done += (child.row.closed ? 1 : 0) + (child.rollup?.done ?? 0);
    }
    node.rollup = { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
  }

  return roots;
}

/** One rendered line: a row, how deep it sits, and whether there is anything under it. */
export interface FlatProjectRow<T extends ProjectHierarchyRow> {
  row: T;
  depth: number;
  hasChildren: boolean;
  rollup: ProjectRollup | null;
  /** The provider's parent chain through this row loops, and was refused. See `ProjectTreeNode`. */
  inCycle: boolean;
}

/**
 * The forest as the lines a table draws, honouring what is open.
 *
 * `expanded` names what is **open**, never what is closed, and that is the whole of "collapsed by
 * default" (AC-1): a table with no state yet passes an empty set and gets its top level. An epic
 * that expanded on load would turn a 20-row table into 60 the first time anyone opened it.
 */
export function flattenProjectHierarchy<T extends ProjectHierarchyRow>(
  nodes: readonly ProjectTreeNode<T>[],
  expanded: ReadonlySet<string>,
): FlatProjectRow<T>[] {
  const flat: FlatProjectRow<T>[] = [];
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    flat.push({
      row: node.row,
      depth: node.depth,
      hasChildren: node.children.length > 0,
      rollup: node.rollup,
      inCycle: node.inCycle,
    });
    if (!expanded.has(node.row.id)) continue;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i];
      if (child) stack.push(child);
    }
  }
  return flat;
}

/** `3/8 · 38%` — written once so the table and anything that later summarises it agree. */
export function formatProjectRollup(rollup: ProjectRollup): string {
  return `${rollup.done}/${rollup.total} · ${rollup.percent}%`;
}

/**
 * How many rows a forest holds, counting every descendant.
 *
 * Here rather than in the table because "how many items is this" must have exactly one answer on
 * a screen that shows the number twice — see the group header in `project-table.tsx`. An explicit
 * stack for the usual reason: the depth is the provider's data, not ours.
 */
export function countProjectRows<T extends ProjectHierarchyRow>(
  nodes: readonly ProjectTreeNode<T>[],
  include?: (row: T) => boolean,
): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) break;
    if (!include || include(node.row)) count += 1;
    for (const child of node.children) stack.push(child);
  }
  return count;
}
