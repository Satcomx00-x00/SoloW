/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { IssueDto, TaskDependencyDto, TaskDto, TaskState } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * The Issue view shows the same Tasks the board does, grouped by intent instead of by lifecycle.
 * A Task that is blocked on the board is blocked here — reading readiness off one route and not
 * the other is how an Owner comes to believe work is ready to run when it is not (issue #6 AC-4).
 *
 * `IssueDetail` now reads `useRouter` (to land on `/issues` after a delete) — stubbed the same
 * way sign-in-form.test.tsx already stubs it for a component with no real App Router mounted.
 *
 * `mock.module` replaces `next/navigation` for the whole bun:test process, not just this file —
 * this codebase has already hit that leak once (activity-bar.test.tsx's mock of
 * `@/lib/auth-client` breaking sign-in-form.test.tsx, a file it never touches directly), so this
 * stub carries every hook other app code under this directory reads from the module
 * (`useSearchParams` in issues-view.tsx), not only the one `IssueDetail` itself needs — a test
 * file elsewhere in the same bun:test run that forgets its own mock would otherwise silently get
 * `undefined` for a hook it never touched here.
 */
const navigationMock = {
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/issues",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
};
mock.module("next/navigation", () => navigationMock);

const { IssueDetail } = await import("./issue-detail");

const issue: IssueDto = {
  id: "issue-1",
  title: "Fix the latch",
  description: null,
  status: "open",
  derivedStatus: "open",
  statusOverride: null,
  statusOverrideAt: null,
  taskCount: 1,
  activeTaskCount: 0,
  source: "local",
  repositoryId: null,
  externalNumber: null,
  externalUrl: null,
  externalId: null,
  externalParentId: null,
  syncedAt: null,
  labels: [],
  linkedChangeRequests: [],
  assignees: [],
  milestone: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeTask(id: string, state: TaskState, title: string): TaskDto {
  return {
    id,
    issueId: issue.id,
    title,
    state,
    agentProfileId: "agent-1",
    executorProfileId: "exec-1",
    repositories: [
      {
        id: "attach-1",
        repositoryId: "repo-1",
        baseRef: null,
        checkoutBranch: "solow/task-1",
        resultBranch: null,
        position: 0,
      },
    ],
    failureReason: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const edge: TaskDependencyDto = {
  taskId: "a",
  blockedByTaskId: "b",
  blockedByTitle: "Order the servo",
  blockedByState: "running",
  createdAt: "2026-01-01T00:00:00.000Z",
};

afterEach(cleanup);

describe("IssueDetail", () => {
  it("marks a blocked Task here too, not only on the board", async () => {
    renderWithTrpc(<IssueDetail issueId={issue.id} />, {
      "issue.get": () => issue,
      "task.list": () => ({ items: [makeTask("a", "ready", "Wire the latch")], nextCursor: null }),
      "task.dependencies": () => [edge],
    });

    expect(
      (await screen.findByRole("button", { name: "Blocked by 1 task" })).textContent,
    ).toContain("1");
  });

  it("waits for the edges rather than drawing a Task that only looks ready", async () => {
    let landEdges: (edges: TaskDependencyDto[]) => void = () => {};
    const edges = new Promise<TaskDependencyDto[]>((resolve) => {
      landEdges = resolve;
    });

    const { log } = renderWithTrpc(<IssueDetail issueId={issue.id} />, {
      "issue.get": () => issue,
      "task.list": () => ({ items: [makeTask("a", "ready", "Wire the latch")], nextCursor: null }),
      "task.dependencies": () => edges,
    });

    await waitFor(() => expect(log.calls.some((c) => c.path === "task.list")).toBe(true));
    expect(screen.queryByText("Wire the latch")).toBeNull();

    landEdges([edge]);
    await screen.findByRole("button", { name: "Blocked by 1 task" });
  });

  it("says so when the edges cannot be loaded", async () => {
    renderWithTrpc(<IssueDetail issueId={issue.id} />, {
      "issue.get": () => issue,
      "task.list": () => ({ items: [makeTask("a", "ready", "Wire the latch")], nextCursor: null }),
      "task.dependencies": () => {
        throw new Error("edges unavailable");
      },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("edges unavailable");
    expect(screen.queryByText("Wire the latch")).toBeNull();
  });
});

/**
 * "New task", from the page whose Issue it is about.
 *
 * This button used to dispatch on a document-level create bus that the shell header's Create menu
 * subscribed to. That menu was removed on request, and with it the bus — so the failure these
 * tests exist for is the silent one: a button left shouting at a listener that no longer exists,
 * opening nothing, with no error anywhere to say so. The page owns the dialog now, which is what
 * makes that unrepresentable.
 */
describe("IssueDetail — starting a Task on this Issue", () => {
  /** The dialog's own four lookups, which only exist once it is mounted. */
  const dialogHandlers = {
    "repository.list": () => ({
      items: [{ id: "repo-1", name: "api", source: "local_path", location: "/srv/api" }],
      nextCursor: null,
    }),
    "profile.agent.list": () => ({ items: [{ id: "agent-1", name: "Claude" }], nextCursor: null }),
    "profile.executor.list": () => ({ items: [{ id: "exec-1", name: "Local" }], nextCursor: null }),
    "issue.list": () => ({ items: [{ ...issue, repositoryId: "repo-1" }], nextCursor: null }),
  };

  const handlers = {
    "issue.get": () => ({ ...issue, repositoryId: "repo-1" }),
    "task.list": () => ({ items: [], nextCursor: null }),
    "task.dependencies": () => [],
  };

  it("the Issue page's New task opens on the Issue you are standing on", async () => {
    renderWithTrpc(<IssueDetail issueId={issue.id} />, { ...handlers, ...dialogHandlers });

    fireEvent.click(
      await within(await screen.findByRole("region", { name: "Tasks for this issue" })).findByRole(
        "button",
        { name: "New task" },
      ),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("New task");
    /*
     * Read off the Issue combobox, not off the dialog's whole text: the Select renders its option
     * list into the same subtree, so this Issue's title is in there whatever the form holds, and
     * an assertion over `dialog.textContent` would pass with the picker sitting empty on its
     * placeholder. What is under test is the picker being *set*, which also means the Repository
     * half of the preset landed first — the picker is disabled on "Select a repository first"
     * until it does.
     */
    await waitFor(() =>
      expect(within(dialog).getByRole("combobox", { name: "Issue" }).textContent).toBe(issue.title),
    );
  });

  it("does not mount the task dialog, or make its four queries, until it is asked for", async () => {
    // The dialog is mounted on demand rather than rendered always and toggled. Rendered always,
    // every visit to an Issue page would cost four extra round-trips nobody standing here asked
    // for, and the form state of an abandoned attempt would survive a close.
    const { log } = renderWithTrpc(<IssueDetail issueId={issue.id} />, {
      ...handlers,
      "task.list": () => ({ items: [makeTask("a", "ready", "Wire the latch")], nextCursor: null }),
    });

    await screen.findByText("Wire the latch");

    expect(screen.queryByRole("dialog")).toBeNull();
    const asked = log.calls.map((c) => c.path);
    expect(asked).not.toContain("repository.list");
    expect(asked).not.toContain("profile.agent.list");
    expect(asked).not.toContain("profile.executor.list");
  });
});

describe("this file's next/navigation mock", () => {
  it("covers usePathname, useSearchParams and useParams too, not only the useRouter IssueDetail itself needs", () => {
    // Asserted against the factory object directly, not through a fresh `import("next/navigation")`:
    // this file's `mock.module` call only wins the process-wide registry race some of the time
    // (whichever test file's own registration for the same specifier runs last), so reading back
    // through the module system here would make this test's own outcome hostage to file-run order
    // instead of to what this file actually authored. What must stay true is that the object passed
    // to `mock.module` — the one this file offers every consumer of `next/navigation` for the rest
    // of the run — carries these three hooks, not only `useRouter`.
    expect(navigationMock.usePathname()).toBe("/issues");
    expect(navigationMock.useSearchParams().get("status")).toBeNull();
    expect(navigationMock.useParams()).toEqual({});
  });
});
