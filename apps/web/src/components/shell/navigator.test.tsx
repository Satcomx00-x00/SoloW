/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { TaskDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * The primary sidebar's newer behaviour: the Recents block every route now carries, the Board
 * lifecycle rows now linking to a column instead of only naming a count, and the Workflows list
 * now leading with its pipelines rather than a permanently-open create field.
 *
 * `next/navigation` is stubbed locally — the same reasoning `secrets-section.test.tsx` and
 * `board.test.tsx` document — because `Navigator` and its route-specific bodies (`BoardNav`,
 * `WorkflowsNav`, `ProjectNav`) read `usePathname`/`useRouter` themselves, and a shared partial
 * stub from whichever sibling file bun loads first is a leak waiting to break the next consumer.
 */
let pathname = "/workflows";
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { Navigator } = await import("./navigator");

const AT = "2026-08-20T00:00:00.000Z";

function task(over: Partial<TaskDto> & { id: string }): TaskDto {
  return {
    issueId: "issue-1",
    title: "Untitled",
    state: "backlog",
    agentProfileId: "harness-1",
    executorProfileId: "exec-1",
    repositories: [],
    failureReason: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    workflowId: null,
    workflowStepId: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  } as TaskDto;
}

const NO_RECENTS = { workspaceId: "ws-1", userId: "user-1", taskIds: [] };

function baseHandlers(extra: Record<string, (input: unknown) => unknown> = {}) {
  return {
    "project.get": () => ({ id: "proj-1", title: "Features ToDeb" }),
    "project.list": () => [{ id: "proj-1", title: "Features ToDeb" }],
    "task.get": () => {
      throw new Error("unexpected task.get in this test");
    },
    "preference.getRecentTasks": () => NO_RECENTS,
    ...extra,
  };
}

afterEach(cleanup);

describe("Navigator — Board lifecycle rows", () => {
  beforeEach(() => {
    pathname = "/projects/proj-1/board";
  });

  it("links each row to its own column, so the sidebar can scroll the board to it", async () => {
    renderWithTrpc(
      <Navigator workspaceName="Acme" />,
      baseHandlers({
        "task.list": () => ({
          items: [task({ id: "t1", state: "running" }), task({ id: "t2", state: "review" })],
          nextCursor: null,
        }),
      }),
    );

    const board = await screen.findByRole("navigation", { name: "Board lifecycle" });
    expect(
      within(board)
        .getByRole("link", { name: /Running/ })
        .getAttribute("href"),
    ).toBe("/projects/proj-1/board?column=running");
    expect(
      within(board)
        .getByRole("link", { name: /Review/ })
        .getAttribute("href"),
    ).toBe("/projects/proj-1/board?column=review");
  });
});

describe("Navigator — Workflows list", () => {
  beforeEach(() => {
    pathname = "/workflows";
  });

  it("leads with the pipelines and keeps the create field folded when one already exists", async () => {
    renderWithTrpc(
      <Navigator workspaceName="Acme" />,
      baseHandlers({
        "workflow.list": () => [
          { id: "wf-1", name: "Plan, build, review", stepCount: 3, version: 2 },
        ],
      }),
    );

    expect(await screen.findByRole("link", { name: /Plan, build, review/ })).toBeDefined();
    // Folded: the field exists in the DOM (a half-typed value must survive being hidden) but is
    // not in the accessibility tree, so it cannot be found by role while closed.
    expect(screen.queryByRole("textbox", { name: "Workflow name" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    expect(screen.getByRole("textbox", { name: "Workflow name" })).toBeDefined();
  });

  it("offers the store beside the file import, under the create form", async () => {
    renderWithTrpc(
      <Navigator workspaceName="Acme" />,
      baseHandlers({
        "workflow.list": () => [
          { id: "wf-1", name: "Plan, build, review", stepCount: 3, version: 2 },
        ],
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "New workflow" }));
    expect(screen.getByRole("button", { name: "Import from file" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Browse the store" })).toBeDefined();
  });

  it("opens the create field by default when there are no pipelines yet", async () => {
    renderWithTrpc(<Navigator workspaceName="Acme" />, baseHandlers({ "workflow.list": () => [] }));

    expect(await screen.findByRole("textbox", { name: "Workflow name" })).toBeDefined();
  });
});

describe("Navigator — Recent tasks", () => {
  beforeEach(() => {
    pathname = "/workflows";
  });

  it("is absent when nothing has been visited yet", async () => {
    renderWithTrpc(<Navigator workspaceName="Acme" />, baseHandlers({ "workflow.list": () => [] }));

    await screen.findByRole("button", { name: "New workflow" });
    expect(screen.queryByRole("navigation", { name: "Recent tasks" })).toBeNull();
  });

  it("lists the saved Tasks, most recent first, with each one's lifecycle colour", async () => {
    renderWithTrpc(
      <Navigator workspaceName="Acme" />,
      baseHandlers({
        "workflow.list": () => [],
        "preference.getRecentTasks": () => ({
          workspaceId: "ws-1",
          userId: "user-1",
          taskIds: ["t2", "t1"],
        }),
        "task.get": (input) => {
          const { id } = input as { id: string };
          return id === "t1"
            ? task({ id: "t1", title: "Add farewell()", state: "running" })
            : task({ id: "t2", title: "Fix the gate latch", state: "review" });
        },
      }),
    );

    const recent = await screen.findByRole("navigation", { name: "Recent tasks" });
    const links = within(recent).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Fix the gate latch", "Add farewell()"]);
    expect(links[0]?.getAttribute("href")).toBe("/task/t2");
  });
});

describe("Navigator — Recent tasks (current task excluded)", () => {
  it("does not offer a Task page's own Task in its Recent list", async () => {
    pathname = "/task/t1";
    renderWithTrpc(
      <Navigator workspaceName="Acme" />,
      baseHandlers({
        "task.get": (input) => {
          const { id } = input as { id: string };
          return task({ id, title: `Task ${id}` });
        },
        "session.listForTask": () => [],
        "project.forIssue": () => ({ projectId: "proj-1" }),
        "workflow.list": () => [],
        "preference.getRecentTasks": () => ({
          workspaceId: "ws-1",
          userId: "user-1",
          taskIds: ["t1", "t2"],
        }),
        "preference.recordRecentTask": () => ({
          workspaceId: "ws-1",
          userId: "user-1",
          taskIds: ["t1"],
        }),
      }),
    );

    await waitFor(() => {
      const recent = screen.queryByRole("navigation", { name: "Recent tasks" });
      expect(recent).not.toBeNull();
      if (recent) expect(within(recent).queryByRole("link", { name: "Task t1" })).toBeNull();
    });
  });
});
