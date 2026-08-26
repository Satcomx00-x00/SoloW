/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type {
  LinkedChangeRequest,
  ProjectDto,
  ProjectFieldDto,
  ProjectItemDto,
} from "@gatecontrol/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { formatValue, type ProjectRow, ProjectTable } from "./project-table";

/**
 * The project table (issue #126).
 *
 * The assertions that matter are about honesty: a column the provider reports but this build has
 * no renderer for is still shown, a field the provider cannot hold is a value with a reason
 * rather than an input, and a row with no group value is a group of its own rather than a row
 * that quietly disappears.
 */

afterEach(cleanup);

const field = (over: Partial<ProjectFieldDto> & Pick<ProjectFieldDto, "id">): ProjectFieldDto => ({
  providerFieldId: `p-${over.id}`,
  name: "Status",
  type: "single_select",
  options: [
    { id: "opt-todo", name: "Todo" },
    { id: "opt-doing", name: "In progress" },
  ],
  iterations: [],
  position: 0,
  readOnly: false,
  readOnlyReason: null,
  ...over,
});

const project = (fields: ProjectFieldDto[]): ProjectDto => ({
  id: "prj-1",
  integrationId: "int-1",
  providerProjectId: "PVT_1",
  title: "Roadmap",
  syncedAt: "2026-08-25T10:00:00.000Z",
  itemCount: 0,
  fields,
  createdAt: "2026-08-25T09:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
});

const row = (
  id: string,
  title: string,
  values: ProjectItemDto["values"] = {},
  over: Partial<ProjectRow> = {},
): ProjectRow => ({
  item: {
    id,
    providerItemId: `i-${id}`,
    issueId: `iss-${id}`,
    position: 0,
    archivedAt: null,
    values,
    issueExternalId: null,
    parentExternalId: null,
    repositoryId: null,
    closed: false,
  },
  title,
  issueNumber: 42,
  issueUrl: null,
  linkedChangeRequests: [],
  labels: [],
  ...over,
});

describe("ProjectTable", () => {
  it("takes its columns from the project's fields, not from a list written here", () => {
    render(
      <ProjectTable
        project={project([field({ id: "f1", name: "Status" }), field({ id: "f2", name: "Size" })])}
        rows={[row("r1", "Cap the upload size")]}
        groupByFieldId={null}
      />,
    );

    expect(screen.getByRole("columnheader", { name: /status/i })).toBeDefined();
    expect(screen.getByRole("columnheader", { name: /size/i })).toBeDefined();
  });

  it("shows a field the provider cannot hold as a value with its reason, not an input", () => {
    // F23 FR-5, and Decision 0018's whole point: a GitLab Free workspace sees why, in words.
    render(
      <ProjectTable
        project={project([
          field({
            id: "f1",
            name: "Estimate",
            type: "number",
            readOnly: true,
            readOnlyReason: "GitLab weights need a paid tier",
          }),
        ])}
        rows={[row("r1", "Cap the upload size")]}
        groupByFieldId={null}
      />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("groups in the field's own option order, not alphabetically", () => {
    // Todo → In progress is an order somebody chose. Re-sorting it would be the table
    // overruling the project.
    const status = field({ id: "f1", name: "Status" });
    render(
      <ProjectTable
        project={project([status])}
        rows={[
          row("r1", "Second", { f1: { type: "single_select", optionId: "opt-doing" } }),
          row("r2", "First", { f1: { type: "single_select", optionId: "opt-todo" } }),
        ]}
        groupByFieldId="f1"
      />,
    );

    const headers = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(headers[0]).toContain("Todo");
    expect(headers[1]).toContain("In progress");
  });

  it("gives rows with no value a group of their own rather than dropping them", () => {
    // "Not decided" is an answer. A table showing fewer rows than the project has is worse than
    // one with an extra heading.
    render(
      <ProjectTable
        project={project([field({ id: "f1", name: "Status" })])}
        rows={[
          row("r1", "Unsorted"),
          row("r2", "Sorted", { f1: { type: "single_select", optionId: "opt-todo" } }),
        ]}
        groupByFieldId="f1"
      />,
    );

    expect(screen.getByRole("button", { name: /no status/i })).toBeDefined();
    expect(screen.getByText("Unsorted")).toBeDefined();
  });

  it("counts each group, and collapses it", () => {
    render(
      <ProjectTable
        project={project([field({ id: "f1", name: "Status" })])}
        rows={[row("r1", "A", { f1: { type: "single_select", optionId: "opt-todo" } })]}
        groupByFieldId="f1"
      />,
    );
    const header = screen.getByRole("button", { name: /todo/i });
    expect(header.textContent).toContain("1");

    fireEvent.click(header);

    expect(screen.queryByText("A")).toBeNull();
  });

  it("renders one flat list when nothing is grouped", () => {
    render(
      <ProjectTable
        project={project([field({ id: "f1" })])}
        rows={[row("r1", "A"), row("r2", "B")]}
        groupByFieldId={null}
      />,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("A")).toBeDefined();
    expect(screen.getByText("B")).toBeDefined();
  });

  it("hides a column the user turned off", () => {
    render(
      <ProjectTable
        project={project([field({ id: "f1", name: "Status" }), field({ id: "f2", name: "Size" })])}
        rows={[row("r1", "A")]}
        groupByFieldId={null}
        hiddenFieldIds={["f2"]}
      />,
    );

    expect(screen.queryByRole("columnheader", { name: /size/i })).toBeNull();
  });
});

/**
 * The provider's hierarchy, nested (issue #127).
 *
 * Every assertion here is about a way the provider's answer can be worse than a tree: a parent
 * that is not in the project, a child in another repository, a cycle. The shape of the graph is
 * proven in `@gatecontrol/core`; what is proven here is that the table draws what it is given —
 * collapsed, indented, counted, and never twice.
 */
describe("hierarchy", () => {
  /** A row carrying the four provider facts nesting resolves on. */
  const nested = (
    id: string,
    title: string,
    over: Partial<ProjectItemDto> = {},
    values: ProjectItemDto["values"] = {},
  ): ProjectRow => {
    const base = row(id, title, values);
    return {
      ...base,
      item: { ...base.item, issueExternalId: id, repositoryId: "repo-1", ...over },
    };
  };

  const status = () => field({ id: "f1", name: "Status" });

  it("gives the header exactly as many cells as a body row", () => {
    /*
     * The invariant that broke, and that thirty-seven other tests did not notice.
     *
     * The row-number gutter was added to the body and not to the header, so the header row was one
     * cell short and every label rendered over the column to its left — "Title" above the numbers,
     * "Linked changes" above the titles. Nothing asserted parity, so the suite stayed green while
     * the table was unreadable; only looking at it caught it. Counting cells is the cheap check
     * that would have.
     */
    render(
      <ProjectTable
        project={project([status()])}
        rows={[nested("r1", "A row")]}
        groupByFieldId={null}
      />,
    );

    const [header, ...body] = screen.getAllByRole("row");
    expect(header?.children.length).toBeGreaterThan(0);
    for (const row of body) {
      expect(row.children.length).toBe(header?.children.length ?? -1);
    }
  });

  it("puts the issue's own number at the start of every row, sub-issues included", () => {
    /*
     * Not the row's position in the table.
     *
     * The gutter held an ordinal for exactly one iteration, and an ordinal is the wrong number to
     * show: it changes with every sort, filter and expand, so it names nothing anyone can quote
     * twice. `#42` is the issue's identity — stable, meaningful on the provider, and the number a
     * person actually says out loud. A sub-issue has one too, so it gets one.
     */
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          { ...nested("epic", "Epic"), issueNumber: 10 },
          { ...nested("child", "Child", { parentExternalId: "epic" }), issueNumber: 11 },
        ]}
        groupByFieldId={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /expand epic/i }));

    const first = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.firstElementChild?.textContent ?? "");
    expect(first).toEqual(["#10", "#11"]);
  });

  it("nests children under their parent, collapsed by default (AC-1)", () => {
    // An epic that expands on load turns a 20-row table into 60. The chevron is the way in, and
    // the only way in.
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          nested("epic", "Sources as a catalogue"),
          nested("c1", "List the sources", { parentExternalId: "epic" }),
          nested("c2", "Browse one source", { parentExternalId: "epic" }),
        ]}
        groupByFieldId={null}
      />,
    );

    expect(screen.queryByText("List the sources")).toBeNull();
    const chevron = screen.getByRole("button", { name: /expand sources as a catalogue/i });
    expect(chevron.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(chevron);

    expect(screen.getByText("List the sources")).toBeDefined();
    expect(screen.getByText("Browse one source")).toBeDefined();
  });

  it("counts done from the provider's closed state, not from a Status field (AC-2 / AC-3)", () => {
    // The child that says "Done" in the Status column is open on the provider, and the one that
    // says "Todo" is closed. A status column is a team's convention; closed is a fact.
    const done = { f1: { type: "single_select" as const, optionId: "opt-doing" } };
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          nested("epic", "Epic"),
          nested("c1", "Says doing, is closed", { parentExternalId: "epic", closed: true }),
          nested("c2", "Says doing, is open", { parentExternalId: "epic" }, done),
        ]}
        groupByFieldId={null}
      />,
    );

    // The count and the percentage are separate nodes now — the reference renders progress as a
    // segmented bar between them (§4), not as one label.
    expect(screen.getByText("1/2")).toBeDefined();
    expect(screen.getByText("50%")).toBeDefined();
  });

  it("counts a child that lives in another repository (AC-4)", () => {
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          nested("epic", "Epic", { repositoryId: "repo-1" }),
          nested("here", "Same repo", {
            parentExternalId: "epic",
            repositoryId: "repo-1",
            closed: true,
          }),
          nested("there", "Other repo", {
            parentExternalId: "epic",
            repositoryId: "repo-2",
            closed: true,
          }),
        ]}
        groupByFieldId={null}
      />,
    );

    expect(screen.getByText("2/2")).toBeDefined();
    expect(screen.getByText("100%")).toBeDefined();
  });

  it("renders a child whose parent is absent from the project at the top level (AC-5)", () => {
    // The epic lives in a repository nobody added. Dropping the child would hide real work.
    render(
      <ProjectTable
        project={project([status()])}
        rows={[nested("orphan", "Child of an epic elsewhere", { parentExternalId: "not-here" })]}
        groupByFieldId={null}
      />,
    );

    expect(screen.getByText("Child of an epic elsewhere")).toBeDefined();
    expect(screen.queryByRole("button", { name: /expand/i })).toBeNull();
  });

  it("draws every row of a cycle the provider reported at the top level (AC-6)", () => {
    // Without the refusal this render never returns: A is under B is under A. And with the
    // cheaper version of it — drop the one edge that closes the loop — it returned, but drew B
    // nested under A as though the provider had said so, progress badge and all.
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          nested("a", "First half of the cycle", { parentExternalId: "b" }),
          nested("b", "Second half of the cycle", { parentExternalId: "a" }),
        ]}
        groupByFieldId={null}
      />,
    );

    // A header row and both halves, with nothing expanded: neither is nested under the other,
    // and neither offers a chevron that would claim it has children.
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getAllByText(/half of the cycle/)).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /expand/i })).toBeNull();
    expect(screen.queryByText(/\d+\/\d+ ·/)).toBeNull();
  });

  it("marks a refused row so the reader knows the provider contradicted itself", () => {
    // The half of AC-6 a silent fix misses: an unexplained top-level row and a refused one look
    // identical, so the refusal has to be said. Quietly — a marker with a sentence on it, not an
    // alarm — and in text, not only in an icon.
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          nested("a", "First half of the cycle", { parentExternalId: "b" }),
          nested("b", "Second half of the cycle", { parentExternalId: "a" }),
        ]}
        groupByFieldId={null}
      />,
    );

    expect(screen.getAllByText(/parent chain looping back to itself/i)).toHaveLength(2);
    expect(screen.getAllByTitle(/parent chain looping back to itself/i)).toHaveLength(2);
    // Nothing that reads as an error: this is the provider's data being odd, not a failure here.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says nothing of the sort about an ordinary hierarchy", () => {
    // A marker that showed up on healthy rows would be a marker nobody reads by the time it
    // matters.
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          nested("epic", "Epic"),
          nested("c1", "Child", { parentExternalId: "epic" }),
          nested("orphan", "Parent lives elsewhere", { parentExternalId: "not-here" }),
        ]}
        groupByFieldId={null}
      />,
    );

    expect(screen.queryByText(/parent chain looping back/i)).toBeNull();
  });

  it("draws the same rows whichever order the provider listed the cycle in", () => {
    // The defect this replaces was order-dependent: whichever edge the walk reached last was the
    // one dropped, so re-paging the provider's response inverted which row sat on top with no
    // data change behind it. Same three rows, two orders, one shape.
    const cycle = [
      nested("a", "A", { parentExternalId: "b" }),
      nested("b", "B", { parentExternalId: "c" }),
      nested("c", "C", { parentExternalId: "a" }),
    ] as const;
    const titlesOf = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("cell")[0]?.textContent);

    render(<ProjectTable project={project([status()])} rows={[...cycle]} groupByFieldId={null} />);
    const forwards = titlesOf();
    cleanup();
    render(
      <ProjectTable
        project={project([status()])}
        rows={[cycle[2], cycle[0], cycle[1]]}
        groupByFieldId={null}
      />,
    );

    // Row order is the provider's and follows the input; what must not move is that all three
    // are top level, undented and unnested — which is what comparing the sorted set proves.
    expect([...titlesOf()].sort()).toEqual([...forwards].sort());
    expect(titlesOf()).toHaveLength(3);
  });

  it("offers nothing that would create a parent the provider cannot store (AC-7)", () => {
    // The hierarchy is the provider's (F23, States & rules). An edge invented here would be
    // invisible everywhere else the team works — so there is no control that makes one.
    render(
      <ProjectTable
        project={project([status()])}
        rows={[nested("epic", "Epic"), nested("c1", "Child", { parentExternalId: "epic" })]}
        groupByFieldId={null}
      />,
    );

    expect(screen.queryByRole("button", { name: /parent|sub-issue|nest/i })).toBeNull();
    expect(screen.queryByText(/add (a )?parent|set parent|make sub-issue/i)).toBeNull();
  });

  it("keeps a child with its parent rather than grouping it away", () => {
    // A row appears once, and the once it appears is under its epic. Grouping a sub-issue by its
    // own Status would shred the hierarchy across four headings.
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          nested("epic", "Epic", {}, { f1: { type: "single_select", optionId: "opt-todo" } }),
          nested(
            "c1",
            "Child",
            { parentExternalId: "epic" },
            { f1: { type: "single_select", optionId: "opt-doing" } },
          ),
        ]}
        groupByFieldId="f1"
      />,
    );

    // One group — the epic's — and the child inside it, not a second heading of its own.
    expect(screen.queryByText("In progress")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /expand epic/i }));
    expect(screen.getByText("Child")).toBeDefined();
  });

  it("counts a group's children as well as its epics", () => {
    // The defect: a header counting only top-level rows read `1` for a group holding one epic
    // and three children, beside a toolbar that counts items and reads `4`. Two numbers on one
    // screen disagreeing, with nothing explaining which is which — so the header means what the
    // toolbar means, and the groups add up to the total.
    render(
      <ProjectTable
        project={project([status()])}
        rows={[
          nested("epic", "Epic", {}, { f1: { type: "single_select", optionId: "opt-todo" } }),
          nested("c1", "One", { parentExternalId: "epic" }),
          nested("c2", "Two", { parentExternalId: "epic" }),
          nested("c3", "Three", { parentExternalId: "epic" }),
        ]}
        groupByFieldId="f1"
      />,
    );

    // Collapsed, so only the epic is drawn — the count is of the group, not of what is on screen.
    expect(screen.getByRole("button", { name: /todo/i }).textContent).toContain("4");
    expect(screen.queryByText("One")).toBeNull();
  });

  it("counts only what the filter admitted, the way the toolbar's first number does", () => {
    // An epic drawn only so its matching child stays reachable is context, not a match. Counting
    // it would make every group read one higher than the `N of M` above it.
    const rows = [
      nested("epic", "Epic", {}, { f1: { type: "single_select", optionId: "opt-todo" } }),
      nested("c1", "One", { parentExternalId: "epic" }),
      nested("c2", "Two", { parentExternalId: "epic" }),
    ];
    render(
      <ProjectTable
        project={project([status()])}
        rows={[rows[1] as ProjectRow]}
        hierarchyRows={rows}
        groupByFieldId="f1"
      />,
    );

    expect(screen.getByRole("button", { name: /todo/i }).textContent).toContain("1");
    expect(screen.getByText("Epic")).toBeDefined();
  });

  it("gives an ordinary issue no progress badge at all", () => {
    // `0/0 · 0%` on every leaf would read as "none of this is done".
    render(
      <ProjectTable
        project={project([status()])}
        rows={[nested("solo", "Just an issue")]}
        groupByFieldId={null}
      />,
    );

    expect(screen.queryByText(/\d+\/\d+ ·/)).toBeNull();
  });
});

describe("formatValue", () => {
  const status = field({ id: "f1" });

  it("shows a single-select by its option's name, not its id", () => {
    expect(formatValue({ type: "single_select", optionId: "opt-doing" }, status)).toBe(
      "In progress",
    );
  });

  it("falls back to the id for an option the project no longer lists", () => {
    // A stored value whose option was deleted upstream. The id is ugly and true; blank would be
    // a cell that looks unset when it is not.
    expect(formatValue({ type: "single_select", optionId: "opt-gone" }, status)).toBe("opt-gone");
  });

  describe("linked change requests (issue #128)", () => {
    const link = (over: Partial<LinkedChangeRequest> = {}): LinkedChangeRequest => ({
      externalId: "pr-5",
      number: 5,
      title: "Cap the upload size",
      state: "open",
      url: "https://example.test/pull/5",
      mergedAt: null,
      ...over,
    });

    function renderWith(links: LinkedChangeRequest[]) {
      render(
        <ProjectTable
          project={project([field({ id: "f1" })])}
          rows={[row("r1", "Cap the upload size", {}, { linkedChangeRequests: links })]}
          groupByFieldId={null}
        />,
      );
    }

    it("renders each link as a badge that leaves for the provider", () => {
      // #128 AC-2. The badge's whole job is to end at the provider's own page: this table is not
      // where a pull request is read.
      renderWith([link(), link({ externalId: "pr-6", number: 6, state: "merged" })]);

      const badges = screen.getAllByRole("link");
      expect(badges).toHaveLength(2);
      expect(badges[0]?.getAttribute("href")).toBe("https://example.test/pull/5");
      expect(badges[0]?.textContent).toContain("#5");
    });

    it("says the state in words as well as in colour", () => {
      // A merged badge that is only green is a badge nobody colour-blind can read.
      renderWith([link({ state: "merged", mergedAt: "2026-02-01T00:00:00.000Z" })]);

      expect(screen.getByRole("link").textContent).toContain("merged");
    });

    it("gives a closed change request its own colour, distinct from open and merged", () => {
      // Three states, three colours (#128 AC-2) — and closed is not painted as a failure, because
      // deciding against a change is a decision.
      const classes = (["open", "merged", "closed"] as const).map((state) => {
        cleanup();
        renderWith([link({ state })]);
        return screen.getByRole("link").className;
      });

      expect(new Set(classes).size).toBe(3);
    });

    it("renders an issue with no linked change request as an empty cell, not a missing column", () => {
      // "Nothing is in flight" is the answer a reviewer came for, and a hidden column is not it.
      renderWith([]);

      expect(screen.queryAllByRole("link")).toHaveLength(0);
      expect(screen.getByRole("columnheader", { name: /linked changes/i })).toBeDefined();
    });

    it("counts the overflow rather than growing the row", () => {
      renderWith([
        link({ externalId: "a", number: 1 }),
        link({ externalId: "b", number: 2 }),
        link({ externalId: "c", number: 3 }),
        link({ externalId: "d", number: 4 }),
        link({ externalId: "e", number: 5 }),
      ]);

      expect(screen.getAllByRole("link")).toHaveLength(3);
      expect(screen.getByText("+2")).toBeDefined();
    });

    it("offers nothing to create, review, approve or merge", () => {
      // #128 AC-3, and the refusal issue #104 already names: the moment this column grows a
      // button, the planning table has started becoming a second client for the provider.
      renderWith([link()]);

      expect(screen.queryAllByRole("button")).toHaveLength(0);
      expect(screen.queryByText(/merge|approve|review/i)).toBeNull();
    });
  });

  it("shows an iteration by its title", () => {
    const sprint = field({
      id: "f2",
      type: "iteration",
      options: [],
      iterations: [
        { id: "it1", title: "Sprint 4", startDate: "2026-08-01", endDate: "2026-08-14" },
      ],
    });

    expect(formatValue({ type: "iteration", iterationId: "it1" }, sprint)).toBe("Sprint 4");
  });

  it("joins assignees, and renders an empty list as empty rather than as absent", () => {
    const people = field({ id: "f3", type: "user", options: [] });

    expect(
      formatValue(
        { type: "user", users: [{ login: "satcom", name: null, avatarUrl: null }] },
        people,
      ),
    ).toBe("satcom");
    expect(formatValue({ type: "user", users: [] }, people)).toBe("");
  });

  it("shows a number of zero, which is a value", () => {
    const estimate = field({ id: "f4", type: "number", options: [] });

    expect(formatValue({ type: "number", number: 0 }, estimate)).toBe("0");
  });

  it("renders nothing for a cell with no value", () => {
    expect(formatValue(undefined, status)).toBe("");
  });
});

/**
 * What a rollup counts when a filter is active (the defect an adversarial review found).
 *
 * The badge means `done/total over this epic's children`. Building the hierarchy from the rows
 * that survived the filter silently re-means it to "over the children that survive the current
 * filter" — a number that is wrong, plausible, and accompanied by nothing saying it was narrowed.
 */
describe("a rollup under an active filter", () => {
  const epic = (
    id: string,
    title: string,
    parentId: string | null,
    closed: boolean,
  ): ProjectRow => ({
    item: {
      id,
      providerItemId: `i-${id}`,
      issueId: `iss-${id}`,
      issueExternalId: id,
      // The hierarchy is the provider's, keyed on its ids — the same shape `toNestableRow` reads.
      parentExternalId: parentId,
      repositoryId: "repo-1",
      closed,
      position: 0,
      archivedAt: null,
      values: {},
    },
    title,
    issueNumber: null,
    issueUrl: null,
    linkedChangeRequests: [],
    labels: [],
  });

  const family = [
    epic("E", "Epic", null, false),
    epic("c1", "Child one", "E", true),
    epic("c2", "Child two", "E", true),
    epic("c3", "Child three", "E", false),
  ];

  it("counts every child, not only the ones the filter admits", () => {
    // The regression: with `rows` filtered to [E, c3], the badge used to read 0/1 · 0% for an
    // epic that is two thirds finished.
    render(
      <ProjectTable
        project={project([field({ id: "f1" })])}
        rows={[family[0] as ProjectRow, family[3] as ProjectRow]}
        hierarchyRows={family}
        groupByFieldId={null}
      />,
    );

    expect(screen.getByText(/2\/3/)).toBeDefined();
  });

  it("draws only the rows the filter admits", () => {
    render(
      <ProjectTable
        project={project([field({ id: "f1" })])}
        rows={[family[0] as ProjectRow, family[3] as ProjectRow]}
        hierarchyRows={family}
        groupByFieldId={null}
      />,
    );

    expect(screen.queryByText("Child one")).toBeNull();
    expect(screen.getByText("Epic")).toBeDefined();
  });

  it("keeps a parent drawn when only a child matched", () => {
    // Hiding the epic would hide the match itself, and the filter would read as having found
    // nothing.
    render(
      <ProjectTable
        project={project([field({ id: "f1" })])}
        rows={[family[3] as ProjectRow]}
        hierarchyRows={family}
        groupByFieldId={null}
      />,
    );

    expect(screen.getByText("Epic")).toBeDefined();
  });

  it("counts the same when nothing is filtered", () => {
    render(
      <ProjectTable
        project={project([field({ id: "f1" })])}
        rows={family}
        hierarchyRows={family}
        groupByFieldId={null}
      />,
    );

    expect(screen.getByText(/2\/3/)).toBeDefined();
  });
});

describe("sorting from the column header", () => {
  /*
   * §6. The header reports the view's sort and asks for a change; it never sorts the rows itself.
   * Sorting in two places is how two implementations of one rule start disagreeing — the first
   * time one of them learns about a field type the other does not.
   */
  const sortable = (over: Partial<React.ComponentProps<typeof ProjectTable>> = {}) => (
    <ProjectTable
      project={project([field({ id: "f1", name: "Status" })])}
      rows={[row("r1", "A row")]}
      groupByFieldId={null}
      {...over}
    />
  );

  it("is a plain label when nothing can act on it", () => {
    // A header that looks pressable and is not is worse than no affordance at all.
    render(sortable());

    expect(screen.queryByRole("button", { name: /status/i })).toBeNull();
    expect(screen.getByRole("columnheader", { name: /status/i })).toBeDefined();
  });

  it("asks for the clicked column, ascending, when another column holds the sort", () => {
    const asked: string[] = [];
    render(sortable({ sort: { field: "@title", direction: "asc" }, onSort: (f) => asked.push(f) }));

    fireEvent.click(screen.getByRole("button", { name: /status/i }));

    expect(asked).toEqual(["f1"]);
  });

  it("announces which column carries the sort, and which way", () => {
    // The arrow is invisible to a screen reader; `aria-sort` is the whole answer for one — and it
    // belongs on the `columnheader`, not on the button inside it, where ARIA ignores it outright.
    render(sortable({ sort: { field: "f1", direction: "desc" }, onSort: () => {} }));

    expect(screen.getByRole("columnheader", { name: /status/i }).getAttribute("aria-sort")).toBe(
      "descending",
    );
    expect(screen.getByRole("columnheader", { name: /^title/i }).getAttribute("aria-sort")).toBe(
      "none",
    );
  });
});
