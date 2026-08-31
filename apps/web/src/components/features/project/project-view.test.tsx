/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { IssueDto, ProjectDto, ProjectFieldDto, ProjectViewDto } from "@solow/contracts";
import { DEFAULT_PROJECT_VIEW_CONFIG } from "@solow/contracts";
import { formatProjectFilter, parseProjectFilter } from "@solow/core";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { labelsInRows, selectedLabels, withLabels } from "./project-view";
import type { ProjectViewItem } from "./project-view-model";

/**
 * The `My items` tab, end to end (spec F23 FR-11, issue #129).
 *
 * This is the defect these tests exist for: `@me` used to resolve to the SoloW account
 * name and was compared against the **provider login** the mirror carries on each row. Two
 * different names for one person — so the tab the saved-views feature is named after matched
 * nothing, and looked exactly like a project with nothing assigned to you.
 *
 * So the three claims here are: with a stated mapping the tab shows that person's rows; without
 * one it shows *none* rather than all of them; and the page says the mapping is missing instead
 * of leaving an empty table to be read as an answer.
 *
 * `mock.module` replaces `next/navigation` for the whole bun:test process, not just this file —
 * issue-detail.test.tsx documents that hazard at length — so this stub carries every hook app
 * code under this directory reads from the module, not only the two this component needs.
 */
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/projects",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { ProjectView } = await import("./project-view");

afterEach(cleanup);

const TIMESTAMPS = { createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z" };

/** A project with one Assignees column — the column `assignee:@me` names. */
const PROJECT: ProjectDto = {
  id: "prj-1",
  integrationId: "int-1",
  source: "adopted",
  providerProjectId: "PVT_1",
  title: "Roadmap",
  syncedAt: "2026-08-25T10:00:00.000Z",
  itemCount: 0,
  fields: [
    {
      id: "f-assignees",
      providerFieldId: "PVTF_1",
      name: "Assignees",
      type: "user",
      options: [],
      iterations: [],
      position: 0,
      readOnly: true,
      readOnlyReason: "assignees are the provider's",
    },
  ],
  ...TIMESTAMPS,
};

/** Two rows, one held by the person reading and one by somebody else. */
const ITEMS = {
  items: [
    {
      id: "item-1",
      providerItemId: "PVTI_1",
      issueId: "iss-1",
      position: 0,
      archivedAt: null,
      values: {
        "f-assignees": {
          type: "user" as const,
          users: [{ login: "ada-on-the-host", name: "Ada", avatarUrl: null }],
        },
      },
      issueExternalId: "1",
      parentExternalId: null,
      // Carried on the row so the right-click hand-off has a Repository to preset alongside the
      // Issue — without it the Task dialog's Issue picker stays disabled and shows nothing.
      repositoryId: "repo-1",
      closed: false,
    },
    {
      id: "item-2",
      providerItemId: "PVTI_2",
      issueId: "iss-2",
      position: 1,
      archivedAt: null,
      values: {
        "f-assignees": {
          type: "user" as const,
          users: [{ login: "grace-on-the-host", name: "Grace", avatarUrl: null }],
        },
      },
      issueExternalId: "2",
      parentExternalId: null,
      repositoryId: "repo-1",
      closed: false,
    },
  ],
  total: 2,
  truncated: false,
};

function issue(id: string, title: string): IssueDto {
  return {
    id,
    title,
    description: null,
    status: "open",
    derivedStatus: "open",
    statusOverride: null,
    statusOverrideAt: null,
    taskCount: 0,
    activeTaskCount: 0,
    source: "github",
    repositoryId: null,
    externalNumber: 1,
    externalUrl: null,
    externalId: null,
    externalParentId: null,
    syncedAt: null,
    labels: [],
    linkedChangeRequests: [],
    assignees: [],
    milestone: null,
    ...TIMESTAMPS,
  };
}

/** One saved tab, filtered to whoever is reading — the shared `My items` of the spec. */
const MY_ITEMS: ProjectViewDto = {
  id: "view-1",
  projectId: "prj-1",
  name: "My items",
  position: 0,
  config: { ...DEFAULT_PROJECT_VIEW_CONFIG, filter: parseProjectFilter("assignee:@me") },
  ...TIMESTAMPS,
};

function handlers(login: string | null) {
  return {
    "project.list": () => [PROJECT],
    "project.get": () => PROJECT,
    "project.allItems": () => ITEMS,
    "project.views": () => [MY_ITEMS],
    "issue.list": () => ({
      items: [issue("iss-1", "Cap the upload size"), issue("iss-2", "Rotate the keys")],
      nextCursor: null,
    }),
    "preference.getSurfaceLayout": () => ({
      surface: "project-table",
      workspaceId: "ws-1",
      userId: "ada",
      layout: { order: [], hidden: [], shown: [], widths: {} },
    }),
    "identity.forProject": () => ({ projectId: "prj-1", integrationId: "int-1", login }),
  };
}

describe("ProjectView — resolving @me", () => {
  it("shows the reader's own rows once their provider login is stated", async () => {
    // The payoff. `ada-on-the-host` is not a SoloW account name and never could be
    // guessed from one, which is exactly why the mapping has to exist.
    renderWithTrpc(<ProjectView projectId="prj-1" />, handlers("ada-on-the-host"));

    expect(await screen.findByText("Cap the upload size")).toBeDefined();
    expect(screen.queryByText("Rotate the keys")).toBeNull();
  });

  it("matches NOTHING, not everything, when no mapping has been stated", async () => {
    // The direction that matters: a `My items` tab quietly showing the whole project is the
    // worse failure, because nothing about it looks wrong.
    renderWithTrpc(<ProjectView projectId="prj-1" />, handlers(null));

    await waitFor(() => expect(screen.getByText(/0 of 2 items/)).toBeDefined());
    expect(screen.queryByText("Cap the upload size")).toBeNull();
    expect(screen.queryByText("Rotate the keys")).toBeNull();
  });

  it("says the mapping is missing rather than leaving an empty table to be read as an answer", async () => {
    renderWithTrpc(<ProjectView projectId="prj-1" />, handlers(null));

    expect(await screen.findByText(/does not know your login/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Say who you are" })).toBeDefined();
  });

  it("does not nag about the mapping on a view that never asks who you are", async () => {
    // The banner is about *this* filter. Shown unconditionally it would be a warning on every
    // project in the product, most of which never mention `@me`.
    renderWithTrpc(<ProjectView projectId="prj-1" />, {
      ...handlers(null),
      "project.views": () => [{ ...MY_ITEMS, name: "All", config: DEFAULT_PROJECT_VIEW_CONFIG }],
    });

    expect(await screen.findByText("Cap the upload size")).toBeDefined();
    expect(screen.queryByText(/does not know your login/)).toBeNull();
  });
});

/**
 * Narrowing by label, from a menu.
 *
 * The menu writes into the **filter language** rather than keeping a selection beside it: the
 * filter box is what the URL carries and what a saved view stores, and a second copy of the same
 * narrowing would disagree with the text the moment somebody edited either one.
 */
describe("the label filter", () => {
  const item = (labels: string[]): ProjectViewItem =>
    ({ row: { labels } }) as unknown as ProjectViewItem;

  it("offers the labels these rows carry, deduplicated and sorted", () => {
    // Read off the rows, not off the whole workspace: a menu of four hundred labels from
    // repositories this project never touches is a menu nobody scrolls.
    expect(labelsInRows([item(["type/feat", "area/web"]), item(["type/feat"])])).toEqual([
      "area/web",
      "type/feat",
    ]);
  });

  it("reads back what the filter is currently narrowed to", () => {
    expect(selectedLabels(parseProjectFilter("label:type/feat,area/web"))).toEqual([
      "type/feat",
      "area/web",
    ]);
  });

  it("does not read a negated clause as a selection", () => {
    // `-label:blocked` is "hide these", the opposite of what a ticked box means.
    expect(selectedLabels(parseProjectFilter("-label:blocked"))).toEqual([]);
  });

  it("replaces the label clause and leaves every other clause alone", () => {
    const filter = parseProjectFilter('status:"In progress" label:old -label:blocked');

    const next = withLabels(filter, ["type/feat"]);

    expect(formatProjectFilter(next)).toBe('status:"In progress" -label:blocked label:type/feat');
  });

  it("removes the clause entirely when nothing is selected", () => {
    // `label:` with no values matches no rows, which is the opposite of "no longer filtering".
    expect(formatProjectFilter(withLabels(parseProjectFilter("label:a status:Todo"), []))).toBe(
      "status:Todo",
    );
  });

  it("round-trips a label the language has to quote", () => {
    const next = withLabels(parseProjectFilter(""), ["needs info"]);

    expect(selectedLabels(parseProjectFilter(formatProjectFilter(next)))).toEqual(["needs info"]);
  });
});

/**
 * A value changed here has to change *here*, not only on the provider.
 *
 * The defect: every write on this surface invalidated `project.items`, and the table reads
 * `project.allItems`. Two readings of the same rows, and the one nothing was holding is the one
 * that got told. So a Status set from a cell reached GitHub, was mirrored, and the cell went on
 * showing the old token until a reload — which is indistinguishable from the write having failed,
 * and is worse, because the provider has already moved.
 */
describe("a cell edit lands on the screen it was made on", () => {
  const STATUS_PROJECT: ProjectDto = {
    ...PROJECT,
    fields: [
      {
        id: "f-status",
        providerFieldId: "PVTSSF_1",
        name: "Status",
        type: "single_select",
        options: [
          { id: "o-todo", name: "Todo" },
          { id: "o-done", name: "Done" },
        ],
        iterations: [],
        position: 0,
        readOnly: false,
        readOnlyReason: null,
      },
    ],
  };

  const STATUS_ITEMS = {
    ...ITEMS,
    items: [
      {
        ...ITEMS.items[0],
        values: { "f-status": { type: "single_select" as const, optionId: "o-todo" } },
      },
    ],
    total: 1,
  };

  it("re-reads the rows the table is actually holding after a write", async () => {
    let reads = 0;
    const { log } = renderWithTrpc(<ProjectView projectId="prj-1" />, {
      ...handlers("ada-on-the-host"),
      "project.get": () => STATUS_PROJECT,
      "project.allItems": () => {
        reads += 1;
        return STATUS_ITEMS;
      },
      "project.views": () => [{ ...MY_ITEMS, name: "All", config: DEFAULT_PROJECT_VIEW_CONFIG }],
      "project.setValue": () => ({
        itemId: "item-1",
        fieldId: "f-status",
        value: { type: "single_select", optionId: "o-done" },
      }),
    });

    fireEvent.click(
      await screen.findByRole("combobox", { name: /Status for Cap the upload size/ }),
    );
    fireEvent.click(await screen.findByText("Done"));

    await waitFor(() => expect(log.calls.some((c) => c.path === "project.setValue")).toBe(true));
    // The claim: the write is followed by a fresh read of `allItems`, not of the paging query
    // the table never asked for.
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });
});

/**
 * Sorting, from the column headers (user request, 2026-08-27).
 *
 * The toolbar used to carry a `Sort by` dropdown listing every field, beside a direction toggle —
 * two controls naming columns that were already on screen a few pixels below. Choosing
 * `Sort by Status` from a menu when the header reading *Status* is right there is indirection for
 * its own sake.
 *
 * Moving it onto the header is not only a deletion: the header now needs the third state the
 * menu used to own. A sort applied on a header and clearable only somewhere else is a one-way
 * door, which is why the cycle below ends where it started.
 */
describe("sorting from the column headers", () => {
  const SORTABLE: ProjectDto = {
    ...PROJECT,
    fields: [
      {
        id: "f-status",
        providerFieldId: "PVTSSF_1",
        name: "Status",
        type: "single_select",
        options: [{ id: "o-todo", name: "Todo" }],
        iterations: [],
        position: 0,
        readOnly: false,
        readOnlyReason: null,
      },
    ],
  };

  const handlersFor = () => ({
    ...handlers("ada-on-the-host"),
    "project.get": () => SORTABLE,
    "project.views": () => [{ ...MY_ITEMS, name: "All", config: DEFAULT_PROJECT_VIEW_CONFIG }],
  });

  /** What the table says about which column carries the sort. */
  const sortState = () =>
    screen.getByRole("columnheader", { name: /status/i }).getAttribute("aria-sort");
  /**
   * The header's own button, scoped to its `columnheader`.
   *
   * Unscoped, `/status/i` also matches the Status *cell* of every row — which is the point of the
   * column, and exactly why the assertion has to say which Status it means.
   */
  const sortButton = () =>
    within(screen.getByRole("columnheader", { name: /status/i })).getByRole("button", {
      // Named exactly, because the header also holds the resize handle ("Resize Status").
      name: "Status",
    });

  /** Two rows whose Status values sort the opposite way to their arrival order. */
  const REORDERABLE = {
    ...ITEMS,
    items: [
      {
        ...ITEMS.items[0],
        values: { "f-status": { type: "single_select" as const, optionId: "o-zulu" } },
      },
      {
        ...ITEMS.items[1],
        values: { "f-status": { type: "single_select" as const, optionId: "o-alpha" } },
      },
    ],
  };

  /** The row titles, top to bottom, as they are actually drawn. */
  const drawnOrder = () =>
    screen
      .getAllByRole("row")
      .map((row) => row.textContent ?? "")
      .filter((text) => text.includes("Cap the upload size") || text.includes("Rotate the keys"))
      .map((text) => (text.includes("Cap the upload size") ? "Cap" : "Rotate"));

  it("actually reorders the rows, not just the arrow", async () => {
    /*
     * The regression this test exists for.
     *
     * The sort was applied to the filtered row set, and the table draws its order from the
     * *complete* one — it builds the hierarchy from that so an epic's rollup can count children a
     * filter hid. So a header click moved the arrow, set `aria-sort`, and left every row exactly
     * where it was. Every assertion that existed at the time passed, because all of them were
     * about the indicator.
     */
    renderWithTrpc(<ProjectView projectId="prj-1" />, {
      ...handlersFor(),
      "project.get": () => ({
        ...SORTABLE,
        fields: [
          {
            ...(SORTABLE.fields[0] as ProjectFieldDto),
            options: [
              { id: "o-alpha", name: "Alpha" },
              { id: "o-zulu", name: "Zulu" },
            ],
          },
        ],
      }),
      "project.allItems": () => REORDERABLE,
    });

    await screen.findByRole("columnheader", { name: /status/i });
    expect(drawnOrder()).toEqual(["Cap", "Rotate"]);

    fireEvent.click(sortButton());
    // Ascending by Status: `Alpha` before `Zulu`, so the second row comes first.
    await waitFor(() => expect(drawnOrder()).toEqual(["Rotate", "Cap"]));

    fireEvent.click(sortButton());
    await waitFor(() => expect(drawnOrder()).toEqual(["Cap", "Rotate"]));
  });

  it("cycles ascending → descending → none on repeated clicks", async () => {
    renderWithTrpc(<ProjectView projectId="prj-1" />, handlersFor());

    await screen.findByRole("columnheader", { name: /status/i });
    expect(sortState()).toBe("none");

    fireEvent.click(sortButton());
    await waitFor(() => expect(sortState()).toBe("ascending"));

    fireEvent.click(sortButton());
    await waitFor(() => expect(sortState()).toBe("descending"));

    // The third click is the one the toolbar menu used to own. Without it the header can apply a
    // sort it cannot take back.
    fireEvent.click(sortButton());
    await waitFor(() => expect(sortState()).toBe("none"));
  });

  it("says what the next click will do, including that it clears", async () => {
    renderWithTrpc(<ProjectView projectId="prj-1" />, handlersFor());

    await screen.findByRole("columnheader", { name: /status/i });
    expect(sortButton().getAttribute("title")).toBe("Sort by Status");

    fireEvent.click(sortButton());
    await waitFor(() =>
      expect(sortButton().getAttribute("title")).toBe("Sort by Status, descending"),
    );

    fireEvent.click(sortButton());
    await waitFor(() =>
      expect(sortButton().getAttribute("title")).toBe("Clear the sort on Status"),
    );
  });

  it("no longer offers a Sort by menu beside the table", async () => {
    renderWithTrpc(<ProjectView projectId="prj-1" />, handlersFor());

    await screen.findByRole("columnheader", { name: /status/i });
    // The trigger reads "No sort" while nothing is sorted — that string is the menu's own, and
    // its absence is the menu's absence. (`Sort by` is only the placeholder, which never shows,
    // so asserting on it would have passed before this change too.)
    expect(screen.queryByText("No sort")).toBeNull();
  });

  it("keeps the menu for the roadmap, which has no headers to click", async () => {
    // Removing it outright would take sorting away from that layout rather than move it. A
    // control that exists exactly where the direct manipulation cannot is not a duplicate of it.
    renderWithTrpc(<ProjectView projectId="prj-1" />, {
      ...handlersFor(),
      "project.views": () => [
        {
          ...MY_ITEMS,
          name: "Roadmap",
          config: { ...DEFAULT_PROJECT_VIEW_CONFIG, layout: "roadmap" as const },
        },
      ],
    });

    expect(await screen.findByText("No sort")).toBeDefined();
  });
});

/**
 * Deleting the Project itself (user request 2026-08-27) — a confirmation gate, then the mutation,
 * the same two-step `ConfirmAction` interaction `project-repositories-dialog.test.tsx` already
 * proves for detaching a Repository.
 */
/**
 * "Start a task on this issue", from a row's right-click.
 *
 * This handler used to dispatch on a document-level create bus that the shell header's Create
 * menu subscribed to and owned the dialog for. That menu was removed on request and the bus with
 * it, so the failure guarded here is the silent one: a menu item calling a function that opens
 * nothing. This page mounts the dialog itself now.
 */
describe("starting a task from a row", () => {
  /** The Task dialog's own four lookups, which only exist once something mounts it. */
  const taskDialogHandlers = {
    "repository.list": () => ({
      items: [{ id: "repo-1", name: "api", source: "local_path", location: "/srv/api" }],
      nextCursor: null,
    }),
    "profile.agent.list": () => ({ items: [{ id: "agent-1", name: "Claude" }], nextCursor: null }),
    "profile.executor.list": () => ({ items: [{ id: "exec-1", name: "Local" }], nextCursor: null }),
  };

  /** Every row on screen — the `@me` tab would hide the second one, and both are the point. */
  const allRowsHandlers = () => ({
    ...handlers("ada-on-the-host"),
    ...taskDialogHandlers,
    "project.views": () => [{ ...MY_ITEMS, name: "All", config: DEFAULT_PROJECT_VIEW_CONFIG }],
  });

  /**
   * Right-click a row and choose the menu item.
   *
   * Fired on the `tr` itself: `ContextMenuTrigger` is `asChild` around the `TableRow`, so the row
   * element *is* the trigger and there is no wrapper to aim at.
   */
  async function startTaskOn(title: string): Promise<void> {
    const row = (await screen.findByText(title)).closest("tr");
    if (!row) throw new Error(`no row for "${title}"`);
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText("Start a task on this issue"));
  }

  /**
   * What the dialog's Issue picker is *set to*.
   *
   * Read off the combobox rather than off the dialog's whole text: the Select renders its option
   * list into the same subtree, so every row's title is in there whatever the form holds — an
   * assertion over `dialog.textContent` would pass with the picker sitting empty on its
   * placeholder.
   */
  const chosenIssue = async (): Promise<string> =>
    (await within(await screen.findByRole("dialog")).findByRole("combobox", { name: "Issue" }))
      .textContent ?? "";

  it("opens the task dialog on the issue of the row that was right-clicked", async () => {
    renderWithTrpc(<ProjectView projectId="prj-1" />, allRowsHandlers());

    await startTaskOn("Cap the upload size");

    await waitFor(async () => expect(await chosenIssue()).toBe("Cap the upload size"));
  });

  it("opens on the row you actually clicked the second time, not the first", async () => {
    /*
     * The invariant `CreateMenu.close()` used to hold by resetting its preset to undefined, now
     * held by clearing this page's own state on close. A preset kept in a ref, or never cleared,
     * would silently start a Task against the *previously* clicked Issue — a wrong write with
     * nothing on screen to show it went wrong.
     */
    renderWithTrpc(<ProjectView projectId="prj-1" />, allRowsHandlers());

    await startTaskOn("Cap the upload size");
    await waitFor(async () => expect(await chosenIssue()).toBe("Cap the upload size"));

    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await startTaskOn("Rotate the keys");

    await waitFor(async () => expect(await chosenIssue()).toBe("Rotate the keys"));
  });
});

describe("deleting a project", () => {
  it("asks for confirmation before the mutation fires", async () => {
    const calls: unknown[] = [];
    renderWithTrpc(<ProjectView projectId="prj-1" />, {
      ...handlers("ada-on-the-host"),
      "project.delete": (input) => {
        calls.push(input);
        return { id: "prj-1" };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: /delete/i }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(calls).toEqual([{ projectId: "prj-1" }]));
  });
});
