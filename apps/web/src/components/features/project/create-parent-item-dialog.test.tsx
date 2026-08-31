/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { CreateParentItemDialog, epicDateValue } from "./create-parent-item-dialog";
import { issueItemState, parentPlanningItemState } from "./project-create-menu";

/**
 * Flow B of the create workflow (F23a Parts 1 and 3), plus the pure gating the `＋ New` menu leans
 * on.
 *
 * The gating is tested here rather than by driving a radix dropdown: it is a pure function, and
 * the one rule that most needs pinning — a blocked entry is disabled *with a reason* — is a
 * property of that function, not of the menu's chrome.
 *
 * The dialog cases come in two halves, and the split is the point of the feature: the group-container
 * ones are the GitLab flow exactly as it shipped (an unchanged `project.createEpic` payload, the
 * skip-on-one-group rule, a title that survives ← Back), and the repository-container ones are the
 * provider that has no epics at all and still originates a parent.
 */

afterEach(cleanup);

const group = (over: Record<string, unknown> = {}) => ({
  integrationId: "int-1",
  externalId: "g1",
  fullPath: "acme/platform",
  name: "Platform",
  url: "https://gitlab.com/groups/acme/platform",
  ...over,
});

/** A repository row as `repository.list` pages them. */
const repository = (over: Record<string, unknown> = {}) => ({
  id: "rep-1",
  name: "gate",
  source: "remote_url",
  location: "https://github.com/acme/gate.git",
  integrationId: "int-1",
  externalFullName: "acme/gate",
  provider: "github",
  integrationBaseUrl: null,
  issueCount: 0,
  setupFilePatterns: [],
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
  ...over,
});

const page = (items: unknown[]) => ({ items, total: items.length, page: 1, pageSize: 100 });

const groupDialog = (over: Record<string, unknown> = {}) => (
  <CreateParentItemDialog
    projectId="prj-1"
    integrationId="int-1"
    container="group"
    noun="epic"
    open
    onOpenChange={() => {}}
    {...over}
  />
);

const repoDialog = (over: Record<string, unknown> = {}) => (
  <CreateParentItemDialog
    projectId="prj-1"
    integrationId="int-1"
    container="repository"
    noun="parent issue"
    open
    onOpenChange={() => {}}
    {...over}
  />
);

describe("issueItemState", () => {
  it("enables New issue when a provider-backed repository exists", () => {
    expect(issueItemState([{ integrationId: "int-1" }]).enabled).toBe(true);
  });

  it("disables it with a reason when every repository is a local path", () => {
    const state = issueItemState([{ integrationId: null }]);
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/no provider-backed repository/i);
  });
});

describe("parentPlanningItemState", () => {
  const integrations = [{ id: "int-1", provider: "gitlab" }];

  it("enables with the container the manifest declared", () => {
    const state = parentPlanningItemState({
      integrationId: "int-1",
      integrations,
      manifests: [
        {
          id: "gitlab",
          name: "GitLab",
          issueCreates: { epics: true, parentPlanningItem: { container: "group", noun: "epic" } },
        },
      ],
    });
    expect(state.enabled).toBe(true);
    expect(state.container).toBe("group");
    expect(state.integrationId).toBe("int-1");
  });

  it("disables it with a reason when the manifest declares no parent planning item", () => {
    const state = parentPlanningItemState({
      integrationId: "int-1",
      integrations,
      manifests: [{ id: "gitlab", name: "GitLab", issueCreates: { epics: false } }],
    });
    expect(state.enabled).toBe(false);
    expect(state.reason).toBe("GitLab cannot originate a parent planning item.");
  });

  it("disables it on a local project, which has no provider at all", () => {
    const state = parentPlanningItemState({ integrationId: null, integrations, manifests: [] });
    expect(state.enabled).toBe(false);
    expect(state.reason).toMatch(/no provider/i);
  });
});

describe("epicDateValue (three-state)", () => {
  const today = "2026-08-30";
  it("sends undefined for an untouched field — leave the provider's default", () => {
    expect(epicDateValue("", false, today)).toBeUndefined();
  });
  it("sends null for a field cleared on purpose", () => {
    expect(epicDateValue("", true, today)).toBeNull();
  });
  it("sends the parsed date for a fixed one", () => {
    expect(epicDateValue("2026-09-01", true, today)).toBe("2026-09-01");
  });
});

describe("CreateParentItemDialog · group container", () => {
  it("skips the 'Where' modal when only one group comes back", async () => {
    renderWithTrpc(groupDialog(), { "project.listGroups": () => [group()] });

    expect(await screen.findByText("New epic · compose")).toBeDefined();
    expect(screen.getByLabelText("Title")).toBeDefined();
  });

  it("preserves the typed title across ← Back", async () => {
    renderWithTrpc(groupDialog(), {
      "project.listGroups": () => [
        group(),
        group({ externalId: "g2", fullPath: "acme/labs", name: "Labs" }),
      ],
    });

    await screen.findByText("New epic · where");
    fireEvent.click(screen.getByText("acme/platform").closest("button") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("New epic · compose");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Reliability" } });

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    await screen.findByText("New epic · where");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("New epic · compose");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Reliability");
  });

  it("sends the frozen createEpic payload, with a fixed start date and no due date", async () => {
    let received: unknown;
    renderWithTrpc(groupDialog(), {
      "project.listGroups": () => [group()],
      "project.createEpic": (input) => {
        received = input;
        return {
          ...group(),
          iid: 3,
          title: "Reliability",
          state: "open",
          startDate: "2026-09-01",
          dueDate: null,
          groupRef: "acme/platform",
        };
      },
    });

    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Reliability" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-09-01" } });
    fireEvent.click(screen.getByRole("button", { name: /Create epic/ }));

    // Unchanged, field for field, from before the dialog was generalised — this is the assertion
    // that says the GitLab half was not rewritten while the container question was added.
    await waitFor(() =>
      expect(received).toEqual({
        integrationId: "int-1",
        groupRef: "acme/platform",
        projectId: "prj-1",
        title: "Reliability",
        startDate: "2026-09-01",
      }),
    );
  });

  it("keeps the modal open and shows the group's message on a rejection", async () => {
    renderWithTrpc(groupDialog(), {
      "project.listGroups": () => [group()],
      "project.createEpic": () => {
        throw new Error("Insufficient permissions on this group.");
      },
    });

    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Reliability" } });
    fireEvent.click(screen.getByRole("button", { name: /Create epic/ }));

    expect(await screen.findByText("Insufficient permissions on this group.")).toBeDefined();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Reliability");
  });
});

describe("CreateParentItemDialog · repository container", () => {
  it("asks for a repository and never for a group", async () => {
    const { log } = renderWithTrpc(repoDialog(), {
      "repository.list": () => page([repository(), repository({ id: "rep-2", name: "yard" })]),
    });

    await screen.findByText("New parent issue · where");
    expect(screen.getByText("Repository")).toBeDefined();
    // The whole point of the container question: a provider with no groups is never asked for one,
    // where the old dialog asked every provider.
    expect(log.calls.some((c) => c.path === "project.listGroups")).toBe(false);
  });

  it("offers only repositories on the connection the gate approved", async () => {
    renderWithTrpc(repoDialog(), {
      "repository.list": () =>
        page([
          repository(),
          // A provider-backed repository on a *different* connection: legal for an Issue, and not
          // for a parent item, whose container shape only this connection's manifest declared.
          repository({ id: "rep-9", name: "elsewhere", integrationId: "int-2" }),
          repository({ id: "rep-0", name: "local", integrationId: null, provider: null }),
        ]),
    });

    await screen.findByText("New parent issue · where");
    expect(screen.getByText("gate")).toBeDefined();
    expect(screen.queryByText("elsewhere")).toBeNull();
    expect(screen.queryByText("local")).toBeNull();
  });

  it("draws no start/due date controls — an issue has no dates to hold them", async () => {
    renderWithTrpc(repoDialog(), { "repository.list": () => page([repository()]) });

    await screen.findByText("New parent issue · compose");
    expect(screen.queryByLabelText("Start date")).toBeNull();
    expect(screen.queryByLabelText("Due date")).toBeNull();
  });

  it("sends the issue-shaped payload to issue.createParentOnProvider", async () => {
    let received: unknown;
    const { log } = renderWithTrpc(repoDialog(), {
      "repository.list": () => page([repository()]),
      "issue.createParentOnProvider": (input) => {
        received = input;
        return {
          issueId: "iss-1",
          externalNumber: 77,
          externalUrl: "https://github.com/acme/gate/issues/77",
          title: "Stored by the provider",
        };
      },
    });

    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Cold-weather reliability" },
    });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "The big rocks" } });
    fireEvent.change(screen.getByLabelText("New label"), { target: { value: "ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: /Create parent issue/ }));

    await waitFor(() =>
      expect(received).toEqual({
        repositoryId: "rep-1",
        projectId: "prj-1",
        title: "Cold-weather reliability",
        description: "The big rocks",
        labels: ["ops"],
      }),
    );
    // No `groupRef` anywhere, and never down the epic branch.
    expect(log.calls.some((c) => c.path === "project.createEpic")).toBe(false);
  });

  it("keeps the modal open and shows the provider's message on a rejection", async () => {
    renderWithTrpc(repoDialog(), {
      "repository.list": () => page([repository()]),
      "issue.createParentOnProvider": () => {
        throw new Error("Resource not accessible by personal access token.");
      },
    });

    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Reliability" } });
    fireEvent.click(screen.getByRole("button", { name: /Create parent issue/ }));

    expect(
      await screen.findByText("Resource not accessible by personal access token."),
    ).toBeDefined();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Reliability");
  });
});
