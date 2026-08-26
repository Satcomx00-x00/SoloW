import { describe, expect, it } from "bun:test";
import {
  buildProjectHierarchy,
  countProjectRows,
  flattenProjectHierarchy,
  formatProjectRollup,
  type ProjectHierarchyRow,
} from "./project-hierarchy.js";

/**
 * The provider's hierarchy (issue #127).
 *
 * Every case here is a way a provider's answer can be worse than the happy path — a parent that
 * is not in the project, a child in another repository, an id that means two things, a cycle —
 * because the happy path is a tree and the rest is the design. Two invariants every test
 * re-checks: no row is ever dropped (work that cannot be nested is still work), and nothing about
 * the shape depends on the order the provider listed its rows in.
 */

function row(over: Partial<ProjectHierarchyRow> & Pick<ProjectHierarchyRow, "id">) {
  return {
    externalId: over.id,
    parentExternalId: null,
    repositoryId: "repo-1",
    closed: false,
    ...over,
  } satisfies ProjectHierarchyRow;
}

/** Every row in the forest, in flattened order, with nothing collapsed. */
function allIds(rows: readonly ProjectHierarchyRow[]): string[] {
  const roots = buildProjectHierarchy(rows);
  const everything = new Set(rows.map((r) => r.id));
  return flattenProjectHierarchy(roots, everything).map((f) => f.row.id);
}

interface RenderedRow {
  id: string;
  depth: number;
  inCycle: boolean;
  rollup: string;
}

/**
 * What a reader ends up seeing, with the one thing that is legitimately the provider's — the
 * order of roots and siblings — sorted away.
 *
 * That sort is the point: order between siblings *is* the provider's and is kept deliberately,
 * so a comparison across permutations has to exclude it or it would fail for the right reason.
 * What must not move is which row sits under which, how deep, and what each epic's number says.
 */
function shape(rows: readonly ProjectHierarchyRow[]): RenderedRow[] {
  const roots = buildProjectHierarchy(rows);
  const everything = new Set(rows.map((r) => r.id));
  return flattenProjectHierarchy(roots, everything)
    .map((f) => ({
      id: f.row.id,
      depth: f.depth,
      inCycle: f.inCycle,
      rollup: f.rollup ? formatProjectRollup(f.rollup) : "-",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const head = items[i] as T;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  }
  return out;
}

/** A seeded PRNG, so a fuzz failure is a failure anyone can reproduce from the seed alone. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("buildProjectHierarchy", () => {
  it("nests a child under the parent the provider reported", () => {
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "child", parentExternalId: "epic" }),
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.row.id).toBe("epic");
    expect(roots[0]?.children.map((c) => c.row.id)).toEqual(["child"]);
    expect(roots[0]?.children[0]?.depth).toBe(1);
  });

  it("marks nothing as cyclic in a hierarchy that is a tree", () => {
    // The other half of the cycle flag: a marker that appeared on ordinary rows would train the
    // reader to ignore it, which costs exactly the case it exists for.
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "child", parentExternalId: "epic" }),
      row({ id: "orphan", parentExternalId: "elsewhere" }),
    ]);

    expect(roots.every((r) => !r.inCycle)).toBe(true);
    expect(roots[0]?.children.every((c) => !c.inCycle)).toBe(true);
  });

  it("keeps the provider's order between siblings and between roots", () => {
    // Re-sorting would be the table overruling the project, the same rule grouping follows.
    const roots = buildProjectHierarchy([
      row({ id: "b" }),
      row({ id: "a" }),
      row({ id: "b2", parentExternalId: "b" }),
      row({ id: "b1", parentExternalId: "b" }),
    ]);

    expect(roots.map((r) => r.row.id)).toEqual(["b", "a"]);
    expect(roots[0]?.children.map((c) => c.row.id)).toEqual(["b2", "b1"]);
  });

  it("renders a child whose parent is absent from the project at the top level (AC-5)", () => {
    // The failure this guards: a child dropped because its epic lives in a repository nobody
    // added. Work that cannot be nested is still work.
    const roots = buildProjectHierarchy([
      row({ id: "orphan", parentExternalId: "epic-elsewhere" }),
    ]);

    expect(roots.map((r) => r.row.id)).toEqual(["orphan"]);
    expect(roots[0]?.depth).toBe(0);
    // Not cyclic: an epic outside the project is an ordinary, honest gap, and marking it would
    // accuse the provider of contradicting itself when it did no such thing.
    expect(roots[0]?.inCycle).toBe(false);
  });

  it("nests a child that lives in another repository (AC-4)", () => {
    // A provider with global issue ids — GitHub — reports one candidate, wherever it lives.
    const roots = buildProjectHierarchy([
      row({ id: "epic", externalId: "I_100", repositoryId: "repo-1" }),
      row({ id: "child", externalId: "I_200", parentExternalId: "I_100", repositoryId: "repo-2" }),
    ]);

    expect(roots[0]?.children.map((c) => c.row.id)).toEqual(["child"]);
  });

  it("prefers a parent in the child's own repository when an id means two things", () => {
    // GitLab's `iid` restarts at 1 per project, so "#1" is not a key on its own. Nesting under
    // whichever "#1" happened to be listed first would put a row under a stranger's epic.
    const roots = buildProjectHierarchy([
      row({ id: "other-1", externalId: "1", repositoryId: "repo-2" }),
      row({ id: "mine-1", externalId: "1", repositoryId: "repo-1" }),
      row({ id: "child", externalId: "7", parentExternalId: "1", repositoryId: "repo-1" }),
    ]);

    const mine = roots.find((r) => r.row.id === "mine-1");
    expect(mine?.children.map((c) => c.row.id)).toEqual(["child"]);
  });

  it("refuses to guess when an ambiguous parent lives in neither repository", () => {
    // Two candidates, neither the child's own: top level rather than a coin toss.
    const roots = buildProjectHierarchy([
      row({ id: "a", externalId: "1", repositoryId: "repo-2" }),
      row({ id: "b", externalId: "1", repositoryId: "repo-3" }),
      row({ id: "child", externalId: "7", parentExternalId: "1", repositoryId: "repo-1" }),
    ]);

    expect(roots.map((r) => r.row.id)).toEqual(["a", "b", "child"]);
  });

  it("refuses two candidates inside the child's own repository too", () => {
    // A duplicated mirror row, or a provider paging the same issue twice. Taking the first would
    // make the nesting depend on which copy arrived first — the same order-dependence a cycle
    // used to have, in a quieter place.
    const roots = buildProjectHierarchy([
      row({ id: "copy-a", externalId: "1", repositoryId: "repo-1" }),
      row({ id: "copy-b", externalId: "1", repositoryId: "repo-1" }),
      row({ id: "child", externalId: "7", parentExternalId: "1", repositoryId: "repo-1" }),
    ]);

    expect(roots.map((r) => r.row.id)).toEqual(["copy-a", "copy-b", "child"]);
  });

  it("refuses a row that reports itself as its own parent, and says so", () => {
    // A one-row loop is a loop. Handled by the same refusal as every other, so the reader is
    // told the same thing rather than being shown a plain row that quietly lost an edge.
    const roots = buildProjectHierarchy([row({ id: "self", parentExternalId: "self" })]);

    expect(roots.map((r) => r.row.id)).toEqual(["self"]);
    expect(roots[0]?.children).toHaveLength(0);
    expect(roots[0]?.inCycle).toBe(true);
  });
});

describe("a cycle the provider reported (AC-6)", () => {
  it("renders every row of the loop at the top level, marked, none nested under another", () => {
    // The defect this replaces: dropping only the edge that closed the loop left B nested under
    // A as an ordinary parent/child — a hierarchy the provider never asserted, with a progress
    // badge on it and nothing on screen saying it had been invented.
    const roots = buildProjectHierarchy([
      row({ id: "a", parentExternalId: "b" }),
      row({ id: "b", parentExternalId: "a" }),
    ]);

    expect(roots.map((r) => r.row.id)).toEqual(["a", "b"]);
    expect(roots.every((r) => r.children.length === 0)).toBe(true);
    expect(roots.every((r) => r.inCycle)).toBe(true);
    expect(roots.every((r) => r.rollup === null)).toBe(true);
  });

  it("does not unparent a row that merely hangs below the loop", () => {
    // c is not part of the contradiction; it points at one member of it. Refusing its edge too
    // would scatter work that nests perfectly well.
    const roots = buildProjectHierarchy([
      row({ id: "c", parentExternalId: "b" }),
      row({ id: "a", parentExternalId: "b" }),
      row({ id: "b", parentExternalId: "a" }),
    ]);

    const b = roots.find((r) => r.row.id === "b");
    expect(roots.map((r) => r.row.id).sort()).toEqual(["a", "b"]);
    expect(b?.children.map((c) => c.row.id)).toEqual(["c"]);
    expect(b?.children[0]?.inCycle).toBe(false);
  });

  it("renders a three-row cycle as three top-level rows", () => {
    const roots = buildProjectHierarchy([
      row({ id: "a", parentExternalId: "c" }),
      row({ id: "b", parentExternalId: "a" }),
      row({ id: "c", parentExternalId: "b" }),
    ]);

    expect(roots.map((r) => r.row.id)).toEqual(["a", "b", "c"]);
    expect(roots.every((r) => r.inCycle && r.children.length === 0)).toBe(true);
  });

  it("refuses each of several disjoint cycles on its own", () => {
    // Two loops plus a plain row: the walk must ground each of them separately, and must not
    // decide the plain row is guilty by association.
    const roots = buildProjectHierarchy([
      row({ id: "plain" }),
      row({ id: "x", parentExternalId: "y" }),
      row({ id: "y", parentExternalId: "x" }),
      row({ id: "p", parentExternalId: "q" }),
      row({ id: "q", parentExternalId: "p" }),
    ]);

    expect(roots.map((r) => r.row.id).sort()).toEqual(["p", "plain", "q", "x", "y"]);
    expect(
      roots
        .filter((r) => r.inCycle)
        .map((r) => r.row.id)
        .sort(),
    ).toEqual(["p", "q", "x", "y"]);
  });

  it("renders the same shape whatever order the provider lists the rows in", () => {
    // The defect in one sentence: which edge closed the loop was whichever the walk reached
    // last, so a provider that re-paged its response inverted which row sat on top — with no
    // data change behind it. All 24 permutations of one cycle-plus-child must agree.
    const rows = [
      row({ id: "a", parentExternalId: "b" }),
      row({ id: "b", parentExternalId: "c" }),
      row({ id: "c", parentExternalId: "a" }),
      row({ id: "leaf", parentExternalId: "b", closed: true }),
    ];
    const expected = shape(rows);

    expect(expected).toEqual([
      { id: "a", depth: 0, inCycle: true, rollup: "-" },
      { id: "b", depth: 0, inCycle: true, rollup: "1/1 · 100%" },
      { id: "c", depth: 0, inCycle: true, rollup: "-" },
      { id: "leaf", depth: 1, inCycle: false, rollup: "-" },
    ]);
    for (const ordering of permutations(rows)) {
      expect(shape(ordering)).toEqual(expected);
    }
  });

  it("survives a chain long enough to overflow a recursive walk", () => {
    // 20_000 rows in one line, with the last pointing back at the first. Recursion dies here;
    // the explicit stack does not. A provider's hierarchy has no bound this product sets.
    const rows: ProjectHierarchyRow[] = [];
    for (let i = 0; i < 20_000; i++) {
      rows.push(row({ id: `n${i}`, parentExternalId: i === 0 ? "n19999" : `n${i - 1}` }));
    }

    // One 20_000-long loop: every row is a member, so every row is a top-level row.
    expect(allIds(rows)).toHaveLength(20_000);
    expect(buildProjectHierarchy(rows)).toHaveLength(20_000);
  });

  it("terminates and keeps every row for any graph at all (fuzz)", () => {
    // Random parents over the same id space produce self-loops, several loops at once, long
    // chains into a loop, and trees — the shapes nobody thinks to write by hand. Seeded, so a
    // failure is reproducible from the seed rather than from luck.
    const random = seeded(0x9e3779b9);
    for (let trial = 0; trial < 300; trial++) {
      const size = 1 + Math.floor(random() * 12);
      const rows: ProjectHierarchyRow[] = [];
      for (let i = 0; i < size; i++) {
        const pick = Math.floor(random() * (size + 1));
        rows.push(
          row({
            id: `n${i}`,
            parentExternalId: pick === size ? null : `n${pick}`,
            closed: random() < 0.5,
          }),
        );
      }

      const rendered = shape(rows);
      // Every row exactly once — nothing dropped, nothing drawn twice.
      expect(rendered).toHaveLength(size);
      // A refused row is a top-level row. If one were ever left nested, the reader would be
      // looking at the invented hierarchy this whole refusal exists to prevent.
      expect(rendered.filter((r) => r.inCycle).every((r) => r.depth === 0)).toBe(true);

      // The same graph, shuffled: same answer.
      const shuffled = [...rows];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const a = shuffled[i] as ProjectHierarchyRow;
        const b = shuffled[j] as ProjectHierarchyRow;
        shuffled[i] = b;
        shuffled[j] = a;
      }
      expect(shape(shuffled)).toEqual(rendered);
    }
  });
});

describe("rollup", () => {
  it("counts done from the provider's closed state, not from a Status field (AC-3)", () => {
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "c1", parentExternalId: "epic", closed: true }),
      row({ id: "c2", parentExternalId: "epic", closed: false }),
      row({ id: "c3", parentExternalId: "epic", closed: false }),
      row({ id: "c4", parentExternalId: "epic", closed: false }),
    ]);

    expect(roots[0]?.rollup).toEqual({ done: 1, total: 4, percent: 25 });
  });

  it("counts a child in another repository (AC-4)", () => {
    const roots = buildProjectHierarchy([
      row({ id: "epic", externalId: "I_1" }),
      row({
        id: "here",
        externalId: "I_2",
        parentExternalId: "I_1",
        repositoryId: "repo-1",
        closed: true,
      }),
      row({
        id: "elsewhere",
        externalId: "I_3",
        parentExternalId: "I_1",
        repositoryId: "repo-2",
        closed: true,
      }),
    ]);

    expect(roots[0]?.rollup).toEqual({ done: 2, total: 2, percent: 100 });
  });

  it("counts every descendant, not only the direct children", () => {
    // An epic holding one sub-epic with two open issues under it is not 1/1 · 100%.
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "sub", parentExternalId: "epic", closed: true }),
      row({ id: "leaf-1", parentExternalId: "sub" }),
      row({ id: "leaf-2", parentExternalId: "sub" }),
    ]);

    expect(roots[0]?.rollup).toEqual({ done: 1, total: 3, percent: 33 });
  });

  it("gives a leaf no rollup at all", () => {
    // `0/0 · 0%` on every ordinary issue would read as "none of this is done".
    const roots = buildProjectHierarchy([row({ id: "lonely" })]);

    expect(roots[0]?.rollup).toBeNull();
  });

  it("gives a refused cycle member no progress badge over the loop it was in", () => {
    // The old refusal left one member parenting the other and reporting `0/1 · 0%` about it —
    // arithmetic over an edge the provider's own answer contradicts. What survives here is only
    // what hangs *below* the loop, which is work that genuinely nests.
    const roots = buildProjectHierarchy([
      row({ id: "a", parentExternalId: "b" }),
      row({ id: "b", parentExternalId: "a" }),
      row({ id: "c", parentExternalId: "a", closed: true }),
    ]);

    const a = roots.find((r) => r.row.id === "a");
    const b = roots.find((r) => r.row.id === "b");
    expect(a?.rollup).toEqual({ done: 1, total: 1, percent: 100 });
    expect(b?.rollup).toBeNull();
  });
});

describe("flattenProjectHierarchy", () => {
  it("shows only the top level when nothing is expanded (AC-1)", () => {
    // Collapsed by default. An epic that expands on load turns a 20-row table into 60.
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "child", parentExternalId: "epic" }),
      row({ id: "grandchild", parentExternalId: "child" }),
    ]);

    const flat = flattenProjectHierarchy(roots, new Set());

    expect(flat.map((f) => f.row.id)).toEqual(["epic"]);
    expect(flat[0]?.hasChildren).toBe(true);
  });

  it("expands one level at a time, in order", () => {
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "child", parentExternalId: "epic" }),
      row({ id: "grandchild", parentExternalId: "child" }),
      row({ id: "other" }),
    ]);

    expect(flattenProjectHierarchy(roots, new Set(["epic"])).map((f) => f.row.id)).toEqual([
      "epic",
      "child",
      "other",
    ]);
    expect(flattenProjectHierarchy(roots, new Set(["epic", "child"])).map((f) => f.row.id)).toEqual(
      ["epic", "child", "grandchild", "other"],
    );
  });

  it("carries the depth a renderer indents by", () => {
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "child", parentExternalId: "epic" }),
      row({ id: "grandchild", parentExternalId: "child" }),
    ]);

    const flat = flattenProjectHierarchy(roots, new Set(["epic", "child"]));

    expect(flat.map((f) => f.depth)).toEqual([0, 1, 2]);
  });

  it("carries the refusal out to the row a renderer draws", () => {
    // A refusal the renderer cannot see is a refusal the reader cannot see.
    const roots = buildProjectHierarchy([
      row({ id: "a", parentExternalId: "b" }),
      row({ id: "b", parentExternalId: "a" }),
    ]);

    expect(flattenProjectHierarchy(roots, new Set()).map((f) => f.inCycle)).toEqual([true, true]);
  });
});

describe("countProjectRows", () => {
  it("counts descendants, not top-level rows", () => {
    // The group header's number and the toolbar's total are the same claim about the same rows.
    // Counting roots made a group of one epic and ten children read "1" beside a toolbar
    // reading "11 items".
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "c1", parentExternalId: "epic" }),
      row({ id: "c2", parentExternalId: "epic" }),
      row({ id: "g1", parentExternalId: "c1" }),
    ]);

    expect(countProjectRows(roots)).toBe(4);
  });

  it("counts what is collapsed as well as what is drawn", () => {
    // Collapsing an epic hides rows; it does not remove them from the project.
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "c1", parentExternalId: "epic" }),
    ]);

    expect(flattenProjectHierarchy(roots, new Set())).toHaveLength(1);
    expect(countProjectRows(roots)).toBe(2);
  });

  it("counts only the rows a caller admits", () => {
    const roots = buildProjectHierarchy([
      row({ id: "epic" }),
      row({ id: "c1", parentExternalId: "epic" }),
      row({ id: "c2", parentExternalId: "epic" }),
    ]);

    expect(countProjectRows(roots, (r) => r.id !== "c2")).toBe(2);
  });
});

describe("formatProjectRollup", () => {
  it("writes the count and the percentage the one way (AC-2)", () => {
    expect(formatProjectRollup({ done: 3, total: 8, percent: 38 })).toBe("3/8 · 38%");
  });
});
