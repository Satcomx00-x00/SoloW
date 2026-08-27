/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ProjectFieldDto, ProjectItemDto, ProjectViewConfig } from "@solow/contracts";
import { DEFAULT_PROJECT_VIEW_CONFIG, PROJECT_TITLE_KEY } from "@solow/contracts";
import { parseProjectFilter, priorityFromLabels } from "@solow/core";
import type { ProjectRow } from "./project-table";
import {
  applyProjectView,
  currentIterationsFor,
  cycleSort,
  defaultHiddenFieldIds,
  effectiveHiddenFieldIds,
  filterableItemFor,
  hiddenFieldIdsFor,
  type ProjectViewItem,
} from "./project-view-model";

/**
 * Turning a saved view into the rows one tab shows (issue #129).
 *
 * The filter language itself is tested in `@solow/core`; what is tested here is the join
 * between a clause that names a *field* and a row that holds *values* — the place where
 * `status:"In progress"` either finds the column somebody meant or silently finds nothing.
 */

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

const item = (
  id: string,
  title: string,
  values: ProjectItemDto["values"] = {},
  labels: string[] = [],
  closed = false,
): ProjectViewItem => ({
  row: {
    item: {
      id,
      providerItemId: `i-${id}`,
      issueId: `iss-${id}`,
      position: 0,
      archivedAt: null,
      values,
      issueExternalId: `ext-${id}`,
      parentExternalId: null,
      repositoryId: null,
      closed,
    },
    title,
    issueNumber: 42,
    issueUrl: null,
    linkedChangeRequests: [],
    labels,
    // Read from the labels, as `project-view.tsx` does: a fixture that hard-coded null could not
    // catch a filter or a sort that stopped seeing a derived priority.
    priority: priorityFromLabels(labels),
    tasks: null,
  } satisfies ProjectRow,
});

const config = (over: Partial<ProjectViewConfig> = {}): ProjectViewConfig => ({
  ...DEFAULT_PROJECT_VIEW_CONFIG,
  ...over,
});

const status = field({ id: "f-status", name: "Status" });
const people = field({ id: "f-people", name: "Assignees", type: "user", options: [] });
const estimate = field({ id: "f-est", name: "Estimate", type: "number", options: [] });

const rows = [
  item(
    "r1",
    "Cap the upload size",
    {
      "f-status": { type: "single_select", optionId: "opt-doing" },
      "f-people": {
        type: "user",
        users: [
          { login: "ana", name: null, avatarUrl: null },
          { login: "satcom", name: null, avatarUrl: null },
        ],
      },
      "f-est": { type: "number", number: 5 },
    },
    ["blocked", "backend"],
  ),
  item(
    "r2",
    "Download resumes",
    {
      "f-status": { type: "single_select", optionId: "opt-todo" },
      "f-est": { type: "number", number: 13 },
    },
    [],
  ),
  item("r3", "Nothing decided", {}, ["backend"]),
];

const names = (result: ProjectRow[]) => result.map((r) => r.title);

describe("filterableItemFor", () => {
  it("offers a single-select by its option's name, which is what a person can type", () => {
    // The provider's option id is a string nobody has ever read off a screen.
    const bag = filterableItemFor(rows[0] as ProjectViewItem, [status]);

    expect(bag.fields.status).toEqual(["In progress"]);
  });

  it("keeps assignees separate rather than as one rendered string", () => {
    // `formatValue` joins them with a comma because that is how a *cell* reads. A filter has to
    // match one of them, and `assignee:ana` cannot be asked of "satcom, ana".
    const bag = filterableItemFor(rows[0] as ProjectViewItem, [people]);

    expect(bag.fields.assignees).toEqual(["ana", "satcom"]);
  });

  it("answers to the singular of a plural column, because that is how the question is said", () => {
    // The spec's own example is `assignee:@me`; the column is called `Assignees`.
    const bag = filterableItemFor(rows[0] as ProjectViewItem, [people]);

    expect(bag.fields.assignee).toEqual(["ana", "satcom"]);
  });

  it("carries the Issue's labels, which are not a project field at all", () => {
    const bag = filterableItemFor(rows[0] as ProjectViewItem, [status]);

    expect(bag.fields.label).toEqual(["blocked", "backend"]);
  });
});

describe("applyProjectView", () => {
  const fields = [status, people, estimate];

  it("returns every row when the view has no filter", () => {
    expect(applyProjectView(rows, fields, config())).toHaveLength(3);
  });

  it("filters by a named field, by keyword, and by negation together", () => {
    expect(
      names(applyProjectView(rows, fields, config({ filter: parseProjectFilter("status:Todo") }))),
    ).toEqual(["Download resumes"]);
    expect(
      names(applyProjectView(rows, fields, config({ filter: parseProjectFilter("upload") }))),
    ).toEqual(["Cap the upload size"]);
    expect(
      names(
        applyProjectView(rows, fields, config({ filter: parseProjectFilter("-label:blocked") })),
      ),
    ).toEqual(["Download resumes", "Nothing decided"]);
  });

  it("resolves @me against the person reading, not the person who saved the tab", () => {
    const myItems = config({ filter: parseProjectFilter("assignee:@me") });

    expect(names(applyProjectView(rows, fields, myItems, { me: "ana" }))).toEqual([
      "Cap the upload size",
    ]);
    expect(applyProjectView(rows, fields, myItems, { me: "nobody" })).toHaveLength(0);
  });

  it("does not mutate the rows it is given", () => {
    // Every tab is handed the same array. A sort in place would reorder the other tabs with it.
    const before = names(rows.map((r) => r.row));

    applyProjectView(
      rows,
      fields,
      config({ sort: { field: PROJECT_TITLE_KEY, direction: "desc" } }),
    );

    expect(names(rows.map((r) => r.row))).toEqual(before);
  });

  it("sorts a number field numerically, not as text", () => {
    // The failure this guards: 13 sorting before 5 because "1" < "5".
    const sorted = applyProjectView(
      rows,
      fields,
      config({ sort: { field: estimate.id, direction: "asc" } }),
    );

    expect(names(sorted).slice(0, 2)).toEqual(["Cap the upload size", "Download resumes"]);
  });

  it("keeps unset values last in both directions", () => {
    // Nobody reverses a sort in order to read the rows that have no value.
    const asc = applyProjectView(
      rows,
      fields,
      config({ sort: { field: estimate.id, direction: "asc" } }),
    );
    const desc = applyProjectView(
      rows,
      fields,
      config({ sort: { field: estimate.id, direction: "desc" } }),
    );

    expect(names(asc).at(-1)).toBe("Nothing decided");
    expect(names(desc).at(-1)).toBe("Nothing decided");
  });

  it("leaves the mirror's order alone when the sort names a column that is gone", () => {
    // A view outlives a re-sync. Sorting every row by an empty key would look like a shuffle.
    const sorted = applyProjectView(
      rows,
      fields,
      config({ sort: { field: "f-deleted", direction: "asc" } }),
    );

    expect(names(sorted)).toEqual(["Cap the upload size", "Download resumes", "Nothing decided"]);
  });
});

describe("currentIterationsFor", () => {
  const sprint = field({
    id: "f-it",
    name: "Iteration",
    type: "iteration",
    options: [],
    iterations: [
      { id: "it3", title: "Sprint 3", startDate: "2026-08-01", endDate: "2026-08-14" },
      { id: "it4", title: "Sprint 4", startDate: "2026-08-15", endDate: "2026-08-28" },
    ],
  });

  it("resolves @current from today, so a saved tab does not freeze on the day it was saved", () => {
    expect(currentIterationsFor([sprint], new Date("2026-08-20T09:00:00Z"))).toEqual({
      iteration: ["Sprint 4"],
    });
  });

  it("resolves to nothing when no iteration is running, rather than to the nearest one", () => {
    expect(currentIterationsFor([sprint], new Date("2026-09-20T09:00:00Z"))).toEqual({});
  });
});

describe("hiddenFieldIdsFor", () => {
  it("hides nothing when the view shows every column", () => {
    // Null is every column — including the one the provider adds next week.
    expect(hiddenFieldIdsFor([status, estimate], null)).toEqual([]);
  });

  it("hides everything the view's column set leaves out", () => {
    expect(hiddenFieldIdsFor([status, estimate], [status.id])).toEqual([estimate.id]);
    expect(hiddenFieldIdsFor([status, estimate], [])).toEqual([status.id, estimate.id]);
  });
});

describe("which columns a project table shows by default", () => {
  /*
   * A GitHub project arrives with nineteen fields, most of them built-ins the provider reports
   * read-only and fills in for nothing — `Milestone`, `Reviewers`, `Parent issue`. They render as
   * a padlock and a dash on every row, and the four columns that carry data end up off screen.
   *
   * The rule is read off the data, never off a list of field names: a name list would be wrong
   * for the next project and would encode one provider's vocabulary into the table.
   */
  const field = (
    over: Partial<ProjectFieldDto> & Pick<ProjectFieldDto, "id">,
  ): ProjectFieldDto => ({
    providerFieldId: `p-${over.id}`,
    name: over.id,
    type: "text",
    options: [],
    iterations: [],
    position: 0,
    readOnly: false,
    readOnlyReason: null,
    ...over,
  });

  const withValue = (fieldId: string) =>
    item("r1", "A row", { [fieldId]: { type: "text", text: "something" } }).row;
  const empty = item("r2", "Another row").row;

  it("hides a read-only column that is empty on every row", () => {
    const dead = field({ id: "milestone", readOnly: true, readOnlyReason: "provider-owned" });

    expect(defaultHiddenFieldIds([dead], [empty])).toEqual(["milestone"]);
  });

  it("keeps a read-only column that actually carries something", () => {
    // Read-only is not the same as useless: it is how the provider states a fact.
    const stated = field({ id: "repo", readOnly: true, readOnlyReason: "provider-owned" });

    expect(defaultHiddenFieldIds([stated], [withValue("repo")])).toEqual([]);
  });

  it("keeps a writable column even when it is empty everywhere", () => {
    // The empty cell *is* the control. Hiding it would hide the way to fill it in.
    const editable = field({ id: "estimate" });

    expect(defaultHiddenFieldIds([editable], [empty])).toEqual([]);
  });
});

describe("effectiveHiddenFieldIds", () => {
  const dead: ProjectFieldDto = {
    id: "milestone",
    providerFieldId: "p-milestone",
    name: "Milestone",
    type: "text",
    options: [],
    iterations: [],
    position: 0,
    readOnly: true,
    readOnlyReason: "provider-owned",
  };
  const rows = [item("r1", "A row").row];

  it("hides by default what nobody has decided about", () => {
    expect(
      effectiveHiddenFieldIds({
        fields: [dead],
        rows,
        visibleFieldIds: null,
        hidden: [],
        shown: [],
      }),
    ).toEqual(["milestone"]);
  });

  it("lets an explicit show beat the default, which is the whole reason `shown` exists", () => {
    // Without this the user ticks the column on and the default puts it straight back — a control
    // that appears to do nothing.
    expect(
      effectiveHiddenFieldIds({
        fields: [dead],
        rows,
        visibleFieldIds: null,
        hidden: [],
        shown: ["milestone"],
      }),
    ).toEqual([]);
  });

  it("still honours an explicit hide on a column the default would have shown", () => {
    const useful: ProjectFieldDto = { ...dead, id: "status", readOnly: false };

    expect(
      effectiveHiddenFieldIds({
        fields: [useful],
        rows,
        visibleFieldIds: null,
        hidden: ["status"],
        shown: [],
      }),
    ).toEqual(["status"]);
  });
});

/**
 * A priority the provider states in a label rather than in the project's field.
 *
 * The case this exists for is a real one and it is the common one: a GitHub project ships a
 * `Priority` single-select whose options were never configured, while every issue in it carries
 * `prio/p2`. GitLab has done this from the start — its `Priority` field *is* the `priority::`
 * scoped label — so the asymmetry, not the reading, is what was wrong.
 */
describe("a priority carried by labels", () => {
  const priority = field({ id: "f-prio", name: "Priority", options: [] });

  it("answers `priority:` for a row whose field holds nothing", () => {
    const labelled = [item("r1", "Latch sticks", {}, ["type/fix", "prio/p2"])];

    const result = applyProjectView(
      labelled,
      [priority],
      config({ filter: parseProjectFilter("priority:P2") }),
    );

    expect(names(result)).toEqual(["Latch sticks"]);
  });

  it("does not answer for a row whose labels say nothing about priority", () => {
    // The failure this guards: a derived priority defaulting to a rank would make every unlabelled
    // row match somebody's `priority:` filter.
    const plain = [item("r1", "Latch sticks", {}, ["type/fix"])];

    expect(
      applyProjectView(plain, [priority], config({ filter: parseProjectFilter("priority:P2") })),
    ).toEqual([]);
  });

  it("lets the field win where the field holds a value", () => {
    /*
     * The field is the authority. A row whose Priority column shows `High` must not also answer
     * to the `prio/p2` label still sitting on the issue — the column and the filter would then
     * disagree about the same row, and the filter is the one nobody can see.
     */
    const configured = field({
      id: "f-prio",
      name: "Priority",
      options: [{ id: "opt-high", name: "High" }],
    });
    const both = [
      item("r1", "Latch sticks", { "f-prio": { type: "single_select", optionId: "opt-high" } }, [
        "prio/p2",
      ]),
    ];

    expect(
      names(
        applyProjectView(
          both,
          [configured],
          config({ filter: parseProjectFilter("priority:High") }),
        ),
      ),
    ).toEqual(["Latch sticks"]);
    expect(
      applyProjectView(both, [configured], config({ filter: parseProjectFilter("priority:P2") })),
    ).toEqual([]);
  });

  it("sorts derived priorities by urgency, not alphabetically", () => {
    // `Critical` before `P3` is only true on the rank. Sorted as text it reads C before P by
    // accident, and `P1` after `P10` for the same non-reason.
    const mixed = [
      item("r1", "Third", {}, ["prio/p3"]),
      item("r2", "First", {}, ["priority::critical"]),
      item("r3", "Second", {}, ["prio/p1"]),
    ];

    const result = applyProjectView(
      mixed,
      [priority],
      config({ sort: { field: "f-prio", direction: "asc" } }),
    );

    expect(names(result)).toEqual(["First", "Second", "Third"]);
  });
});

/**
 * Hiding finished work.
 *
 * Closed is the **provider's** state, not a Status field reading "Done" — a status is a team's
 * convention and a convention is not a completion.
 */
describe("hideClosed", () => {
  const open = item("r1", "Still open", {}, []);
  const done = item("r2", "Shipped", {}, [], true);

  it("shows everything by default, so no saved view changes meaning", () => {
    expect(names(applyProjectView([open, done], [], config()))).toEqual(["Still open", "Shipped"]);
  });

  it("leaves closed rows out when it is on", () => {
    expect(names(applyProjectView([open, done], [], config({ hideClosed: true })))).toEqual([
      "Still open",
    ]);
  });

  it("still applies the view's own filter to what is left", () => {
    // Two independent narrowings, not one replacing the other.
    const result = applyProjectView(
      [open, done],
      [],
      config({ hideClosed: true, filter: parseProjectFilter("Shipped") }),
    );
    expect(result).toEqual([]);
  });
});

/**
 * Sorting from the column header, which is now the only place it happens.
 *
 * The toolbar used to carry a `Sort by` dropdown beside a direction toggle, so the header only
 * ever had to flip between two directions — "no sort" was a row in that menu. With the menu gone
 * the header owns all three states, and the one that matters is the third: a sort you cannot
 * undo where you applied it is a one-way door.
 */
describe("cycleSort", () => {
  it("starts a fresh column ascending", () => {
    expect(cycleSort(null, "f-status")).toEqual({ field: "f-status", direction: "asc" });
  });

  it("flips the column that is already sorted", () => {
    expect(cycleSort({ field: "f-status", direction: "asc" }, "f-status")).toEqual({
      field: "f-status",
      direction: "desc",
    });
  });

  it("clears on the third click, so the header can undo what it did", () => {
    expect(cycleSort({ field: "f-status", direction: "desc" }, "f-status")).toBeNull();
  });

  it("starts another column ascending rather than inheriting the last direction", () => {
    // Carrying it over gives you Z→A on a column you have never sorted, which nothing on screen
    // explains.
    expect(cycleSort({ field: "f-date", direction: "desc" }, "f-status")).toEqual({
      field: "f-status",
      direction: "asc",
    });
  });
});
