/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { IssueDto, ProjectDto, ProjectViewDto } from "@gatecontrol/contracts";
import { DEFAULT_PROJECT_VIEW_CONFIG } from "@gatecontrol/contracts";
import { parseProjectFilter } from "@gatecontrol/core";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * The `My items` tab, end to end (spec F23 FR-11, issue #129).
 *
 * This is the defect these tests exist for: `@me` used to resolve to the GateControl account
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
      repositoryId: null,
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
      repositoryId: null,
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
    syncedAt: null,
    labels: [],
    linkedChangeRequests: [],
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
    "issue.list": () => [issue("iss-1", "Cap the upload size"), issue("iss-2", "Rotate the keys")],
    "preference.getSurfaceLayout": () => ({
      surface: "project-table",
      workspaceId: "ws-1",
      userId: "ada",
      layout: { order: [], hidden: [] },
    }),
    "identity.forProject": () => ({ projectId: "prj-1", integrationId: "int-1", login }),
  };
}

describe("ProjectView — resolving @me", () => {
  it("shows the reader's own rows once their provider login is stated", async () => {
    // The payoff. `ada-on-the-host` is not a GateControl account name and never could be
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
