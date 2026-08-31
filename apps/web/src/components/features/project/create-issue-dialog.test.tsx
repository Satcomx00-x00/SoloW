/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { CreateIssueDialog } from "./create-issue-dialog";

/**
 * Flow A of the create workflow (F23a Part 1), from the client's side.
 *
 * The assertions worth making are the ones the spec is explicit about: Modal 1 disappears when
 * there is only one place to create in, ← Back does not eat what was typed, the mutation is sent
 * the shape the frozen contract names, the metadata pickers add exactly what was chosen, and a
 * provider refusal leaves the form standing.
 */

afterEach(cleanup);

const repo = (over: Record<string, unknown> = {}) => ({
  id: "repo-1",
  name: "web",
  integrationId: "int-1",
  provider: "gitlab",
  externalFullName: "acme/web",
  ...over,
});

const list = (items: Array<Record<string, unknown>>) => ({
  items,
  total: items.length,
  nextCursor: null,
});

/** The provider-backed pickers every Compose render fires. Defaulted empty; overridden per test. */
const composeReads = {
  "repository.listLabels": () => [],
  "repository.listAssignableUsers": () => [],
  "repository.listMilestones": () => [],
};

/** GitHub's manifest as the registry declares it — the shape the compose form gates on. */
const GITHUB_MANIFEST = {
  id: "github",
  name: "GitHub",
  issueCreates: {
    epics: false,
    dueDate: false,
    weight: false,
    confidential: false,
    timeEstimate: false,
    links: true,
    linkTypes: ["blocks", "is_blocked_by"],
    issueTypes: true,
    parentIssue: true,
    providerProject: true,
  },
};

/** One Projects v2 board on the same connection the chosen Repository lives on. */
const BOARD = {
  integrationId: "int-1",
  provider: "github",
  externalId: "PVT_board",
  title: "Roadmap",
  url: "u",
  ownerLogin: "acme",
  adopted: false,
};

describe("CreateIssueDialog", () => {
  it("skips the 'Where' modal when exactly one repository is eligible", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      { "repository.list": () => list([repo()]), ...composeReads },
    );

    // Straight into Compose — no repository step for a single choice.
    expect(await screen.findByText("New issue · compose")).toBeDefined();
    expect(screen.getByLabelText(/Title/)).toBeDefined();
  });

  it("keeps a purely local repository out of the picker", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () =>
          list([repo({ id: "local", name: "scripts", integrationId: null, provider: null })]),
        ...composeReads,
      },
    );

    // Nothing eligible, so no auto-skip and the 'Where' step states why.
    expect(await screen.findByText(/no provider-backed repository/i)).toBeDefined();
  });

  it("preserves the typed title across ← Back", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo(), repo({ id: "repo-2", name: "api" })]),
        ...composeReads,
      },
    );

    // Two eligible repositories, so the picker is shown rather than skipped.
    await screen.findByText("New issue · where");
    fireEvent.click(screen.getByText("web").closest("button") as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("New issue · compose");
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Cold start" } });

    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    await screen.findByText("New issue · where");
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));

    await screen.findByText("New issue · compose");
    expect((screen.getByLabelText(/Title/) as HTMLInputElement).value).toBe("Cold start");
  });

  it("sends the frozen createOnProvider payload, with projectId attached", async () => {
    let received: unknown;
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo()]),
        ...composeReads,
        "issue.createOnProvider": (input) => {
          received = input;
          return { issueId: "iss-1", externalNumber: 7, externalUrl: "u", title: "Cold start" };
        },
      },
    );

    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: "Cold start" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "It stalls." } });
    fireEvent.click(screen.getByRole("button", { name: /Create issue/ }));

    // Nothing chosen in the sidebar, so no assignees/labels/milestone keys ride along.
    await waitFor(() =>
      expect(received).toEqual({
        repositoryId: "repo-1",
        projectId: "prj-1",
        title: "Cold start",
        description: "It stalls.",
      }),
    );
  });

  it("attaches the assignee, label and milestone chosen in the sidebar", async () => {
    let received: unknown;
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo()]),
        "repository.listLabels": () => [{ name: "bug", color: "#f00", description: null }],
        "repository.listAssignableUsers": () => [
          { login: "ada", name: "Ada Lovelace", avatarUrl: null },
        ],
        "repository.listMilestones": () => [
          { externalId: "42", title: "v1.0", startDate: null, dueDate: null },
        ],
        "issue.createOnProvider": (input) => {
          received = input;
          return { issueId: "iss-1", externalNumber: 7, externalUrl: "u", title: "Cold start" };
        },
      },
    );

    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: "Cold start" } });

    // Assignee picker: open, pick Ada.
    fireEvent.click(screen.getByRole("combobox", { name: "Assignees" }));
    fireEvent.click(await screen.findByText("Ada Lovelace"));
    // Label picker: open, pick bug.
    fireEvent.click(screen.getByRole("combobox", { name: "Labels" }));
    fireEvent.click(await screen.findByText("bug"));
    // Milestone: a Radix Select — trigger is a combobox, its entries are options.
    fireEvent.click(screen.getByRole("combobox", { name: "Milestone" }));
    fireEvent.click(await screen.findByRole("option", { name: "v1.0" }));

    fireEvent.click(screen.getByRole("button", { name: /Create issue/ }));

    await waitFor(() =>
      expect(received).toEqual({
        repositoryId: "repo-1",
        projectId: "prj-1",
        title: "Cold start",
        assignees: ["ada"],
        labels: ["bug"],
        milestone: "42",
      }),
    );
  });

  it("groups scoped labels under category headings, leaving the rest flat", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo()]),
        "repository.listLabels": () => [
          { name: "status/todo", color: "#111", description: null },
          { name: "type::bug", color: "#222", description: null },
          { name: "wontfix", color: "#333", description: null },
        ],
        "repository.listAssignableUsers": () => [],
        "repository.listMilestones": () => [],
      },
    );

    await screen.findByText("New issue · compose");
    fireEvent.click(screen.getByRole("combobox", { name: "Labels" }));

    // The two scoped labels get headed groups; the plain one has no heading (shared flat list).
    expect(await screen.findByText("Status")).toBeDefined();
    expect(screen.getByText("Type")).toBeDefined();
    // Inside a category the prefix drops away — "todo", not "status/todo".
    expect(screen.getByText("todo")).toBeDefined();
    expect(screen.getByText("wontfix")).toBeDefined();
  });

  it("draws the provider-specific fields only when the manifest declares them", async () => {
    const gitlab = {
      id: "gitlab",
      name: "GitLab",
      issueCreates: {
        epics: true,
        dueDate: true,
        weight: true,
        confidential: true,
        timeEstimate: true,
        links: true,
      },
    };
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo()]),
        ...composeReads,
        "integration.providers": () => [gitlab],
        "issue.list": () => list([]),
      },
    );

    await screen.findByText("New issue · compose");
    expect(await screen.findByLabelText("Due date")).toBeDefined();
    expect(screen.getByLabelText("Estimate")).toBeDefined();
    expect(screen.getByLabelText("Weight")).toBeDefined();
    expect(screen.getByText("Confidential")).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Linked items" })).toBeDefined();
  });

  it("draws none of them for a provider whose manifest declares them false", async () => {
    const spartan = {
      id: "spartan",
      name: "Spartan",
      issueCreates: {
        epics: false,
        dueDate: false,
        weight: false,
        confidential: false,
        timeEstimate: false,
        links: false,
      },
    };
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo({ provider: "spartan" })]),
        ...composeReads,
        "integration.providers": () => [spartan],
        "issue.list": () => list([]),
      },
    );

    await screen.findByText("New issue · compose");
    // The whole point of gating on the manifest: this provider's issues hold none of these, so the
    // form never draws a control its driver would refuse.
    expect(screen.queryByLabelText("Due date")).toBeNull();
    expect(screen.queryByLabelText("Weight")).toBeNull();
    expect(screen.queryByText("Confidential")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Linked items" })).toBeNull();
  });

  it("draws GitHub's own three where GitLab's are absent — the gating runs both ways", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo({ provider: "github" })]),
        ...composeReads,
        "integration.providers": () => [GITHUB_MANIFEST],
        "issue.list": () => list([]),
        "repository.listIssueTypes": () => [
          { externalId: "1", name: "Bug", description: null, color: "red" },
        ],
        "project.available": () => [BOARD],
      },
    );

    await screen.findByText("New issue · compose");
    // None of GitLab's, all of GitHub's. Neither set is the standard one with the other bolted on.
    expect(screen.queryByLabelText("Due date")).toBeNull();
    expect(screen.queryByLabelText("Weight")).toBeNull();
    expect(await screen.findByLabelText("Type")).toBeDefined();
    expect(await screen.findByRole("combobox", { name: "Parent issue" })).toBeDefined();
    expect(await screen.findByLabelText("Project board")).toBeDefined();
  });

  it("hides the type picker when the repository inherits no types, flag or not", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo({ provider: "github" })]),
        ...composeReads,
        "integration.providers": () => [GITHUB_MANIFEST],
        "issue.list": () => list([]),
        // The flag says *GitHub* has issue types; the empty list says *this repository* inherits
        // none — a repository owned by a person rather than an organisation. A picker whose only
        // choice is "No type" is a control that means nothing.
        "repository.listIssueTypes": () => [],
        "project.available": () => [BOARD],
      },
    );

    await screen.findByLabelText("Project board");
    expect(screen.queryByLabelText("Type")).toBeNull();
  });

  it("offers only the link relations the provider expresses", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo({ provider: "github" })]),
        ...composeReads,
        "integration.providers": () => [GITHUB_MANIFEST],
        "issue.list": () => list([]),
        "repository.listIssueTypes": () => [],
        "project.available": () => [],
      },
    );

    fireEvent.click(await screen.findByRole("combobox", { name: "Link type" }));

    // GitHub's dependencies are blocking in both directions and nothing else. Offering "Relates
    // to" would collect a relation the driver has to drop on the way out.
    expect(await screen.findByRole("option", { name: "Blocks" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Is blocked by" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "Relates to" })).toBeNull();
  });

  it("links on the provider's own first relation, not a hard-coded 'relates to'", async () => {
    let received: unknown;
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo({ provider: "github" })]),
        ...composeReads,
        "integration.providers": () => [GITHUB_MANIFEST],
        "issue.list": () =>
          list([{ id: "iss-9", title: "The blocker", externalNumber: 10, labels: [] }]),
        "repository.listIssueTypes": () => [],
        "project.available": () => [],
        "issue.createOnProvider": (input) => {
          received = input;
          return { issueId: "i", externalNumber: 7, externalUrl: "u", title: "t" };
        },
      },
    );

    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: "Cold start" } });
    // The relation control is deliberately left untouched, which is the whole point: whatever it
    // opens on is what the link carries. On GitHub that must be "blocks" — a control seeded with
    // a relation the provider does not express would collect one the driver then drops.
    fireEvent.click(await screen.findByRole("combobox", { name: "Linked items" }));
    fireEvent.click(await screen.findByText(/The blocker/));
    fireEvent.click(screen.getByRole("button", { name: /Create issue/ }));

    await waitFor(() =>
      expect(received).toEqual({
        repositoryId: "repo-1",
        projectId: "prj-1",
        title: "Cold start",
        links: [{ issueNumber: 10, type: "blocks" }],
      }),
    );
    // And the trigger agrees with what was sent — the two are the same value by construction.
    expect(screen.getByRole("combobox", { name: "Link type" }).textContent).toBe("Blocks");
  });

  it("offers only the boards on the connection the chosen repository lives on", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo({ provider: "github" })]),
        ...composeReads,
        "integration.providers": () => [GITHUB_MANIFEST],
        "issue.list": () => list([]),
        "repository.listIssueTypes": () => [],
        // `project.available` answers across every connection in the Workspace. A board on a
        // different one cannot hold an issue created here, so it is not offered.
        "project.available": () => [
          BOARD,
          { ...BOARD, integrationId: "int-2", externalId: "PVT_other", title: "Other roadmap" },
        ],
      },
    );

    fireEvent.click(await screen.findByLabelText("Project board"));

    expect(await screen.findByRole("option", { name: /Roadmap/ })).toBeDefined();
    expect(screen.queryByRole("option", { name: /Other roadmap/ })).toBeNull();
  });

  it("hides the board picker when the connection has no boards at all", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo({ provider: "github" })]),
        ...composeReads,
        "integration.providers": () => [GITHUB_MANIFEST],
        "issue.list": () => list([]),
        "repository.listIssueTypes": () => [],
        "project.available": () => [{ ...BOARD, integrationId: "int-2" }],
      },
    );

    // Same second gate the type picker has: the flag says the provider has boards, the list says
    // this connection has none to choose from, and a picker whose only entry is "No board" is a
    // control that means nothing.
    await screen.findByRole("combobox", { name: "Parent issue" });
    expect(screen.queryByLabelText("Project board")).toBeNull();
  });

  it("sends the type, the parent issue and the board only once each was chosen", async () => {
    let received: unknown;
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo({ provider: "github" })]),
        ...composeReads,
        "integration.providers": () => [GITHUB_MANIFEST],
        "issue.list": () =>
          list([{ id: "iss-9", title: "The epic", externalNumber: 10, labels: [] }]),
        "repository.listIssueTypes": () => [
          { externalId: "1", name: "Bug", description: null, color: null },
        ],
        "project.available": () => [BOARD],
        "issue.createOnProvider": (input) => {
          received = input;
          return { issueId: "i", externalNumber: 7, externalUrl: "u", title: "t" };
        },
      },
    );

    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: "Cold start" } });
    fireEvent.click(await screen.findByRole("combobox", { name: "Parent issue" }));
    fireEvent.click(await screen.findByText(/The epic/));
    fireEvent.click(screen.getByRole("button", { name: /Create issue/ }));

    // The parent rode along as the *number* the provider knows it by; the type and the board were
    // never touched, so neither key is present at all.
    await waitFor(() =>
      expect(received).toEqual({
        repositoryId: "repo-1",
        projectId: "prj-1",
        title: "Cold start",
        parentIssueNumber: 10,
      }),
    );
  });

  it("sends due date, weight, confidential and estimate only when they were filled in", async () => {
    let received: unknown;
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo()]),
        ...composeReads,
        "integration.providers": () => [
          {
            id: "gitlab",
            name: "GitLab",
            issueCreates: {
              epics: false,
              dueDate: true,
              weight: true,
              confidential: true,
              timeEstimate: true,
              links: true,
            },
          },
        ],
        "issue.list": () => list([]),
        "issue.createOnProvider": (input) => {
          received = input;
          return { issueId: "i", externalNumber: 7, externalUrl: "u", title: "t" };
        },
      },
    );

    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: "Cold start" } });
    fireEvent.change(await screen.findByLabelText("Due date"), {
      target: { value: "2026-09-30" },
    });
    fireEvent.change(screen.getByLabelText("Weight"), { target: { value: "3" } });
    // Estimate deliberately left empty — an untouched control must send nothing.
    fireEvent.click(screen.getByRole("button", { name: /Create issue/ }));

    await waitFor(() =>
      expect(received).toEqual({
        repositoryId: "repo-1",
        projectId: "prj-1",
        title: "Cold start",
        dueDate: "2026-09-30",
        weight: 3,
      }),
    );
  });

  it("keeps the modal open and shows the provider's message on a rejection", async () => {
    renderWithTrpc(
      <CreateIssueDialog projectId="prj-1" epicsSupported={false} open onOpenChange={() => {}} />,
      {
        "repository.list": () => list([repo()]),
        ...composeReads,
        "issue.createOnProvider": () => {
          throw new Error("Label 'blocked' does not exist.");
        },
      },
    );

    fireEvent.change(await screen.findByLabelText(/Title/), { target: { value: "Cold start" } });
    fireEvent.click(screen.getByRole("button", { name: /Create issue/ }));

    expect(await screen.findByText("Label 'blocked' does not exist.")).toBeDefined();
    // Still on Compose, title intact — nothing typed was lost.
    expect((screen.getByLabelText(/Title/) as HTMLInputElement).value).toBe("Cold start");
  });
});
