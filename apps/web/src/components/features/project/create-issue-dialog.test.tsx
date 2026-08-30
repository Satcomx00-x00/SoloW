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
    const github = {
      id: "github",
      name: "GitHub",
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
        "repository.list": () => list([repo({ provider: "github" })]),
        ...composeReads,
        "integration.providers": () => [github],
        "issue.list": () => list([]),
      },
    );

    await screen.findByText("New issue · compose");
    // The whole point of gating on the manifest: a GitHub issue holds none of these, so the form
    // never draws a control its driver would refuse.
    expect(screen.queryByLabelText("Due date")).toBeNull();
    expect(screen.queryByLabelText("Weight")).toBeNull();
    expect(screen.queryByText("Confidential")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Linked items" })).toBeNull();
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
