/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { ProjectFieldDto, ProjectItemDto, ProjectViewConfig } from "@gatecontrol/contracts";
import { DEFAULT_PROJECT_VIEW_CONFIG, PROJECT_TITLE_KEY } from "@gatecontrol/contracts";
import { parseProjectFilter } from "@gatecontrol/core";
import type { ProjectRow } from "./project-table";
import {
  applyProjectView,
  currentIterationsFor,
  filterableItemFor,
  hiddenFieldIdsFor,
  type ProjectViewItem,
} from "./project-view-model";

/**
 * Turning a saved view into the rows one tab shows (issue #129).
 *
 * The filter language itself is tested in `@gatecontrol/core`; what is tested here is the join
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
      closed: false,
    },
    title,
    issueNumber: 42,
    issueUrl: null,
    linkedChangeRequests: [],
    labels,
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
