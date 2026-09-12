/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { HistoryEntryDto, TaskDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/history",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { HistoryView } = await import("./history-view");

/**
 * History (Decision 0025), as the page: each row says why it is here and what a resume would
 * do, and the two actions go through the Task procedures — nothing here has a rule of its own.
 */

afterEach(cleanup);

const DAY = 24 * 3600 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function task(over: Partial<TaskDto>): TaskDto {
  return {
    id: "task-1",
    issueId: "issue-1",
    title: "Fix the latch",
    state: "done",
    agentProfileId: "harness-1",
    executorProfileId: "exec-1",
    repositories: [
      {
        id: "attach-1",
        repositoryId: "repo-1",
        baseRef: "main",
        checkoutBranch: "solow/task-1",
        resultBranch: null,
        position: 0,
      },
    ],
    failureReason: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    workflowId: null,
    workflowStepId: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const entries: HistoryEntryDto[] = [
  {
    task: task({
      id: "task-deleted",
      title: "Deleted by mistake",
      state: "failed",
      deletedAt: ago(DAY),
    }),
    kind: "deleted",
    since: ago(DAY),
    expiresAt: new Date(Date.now() + 6 * DAY).toISOString(),
    resumable: "conversation",
    issueTitle: "Fix the latch",
    repositoryName: "platform",
  },
  {
    task: task({ id: "task-done", title: "Shipped the latch", state: "done" }),
    kind: "done",
    since: ago(2 * DAY),
    expiresAt: new Date(Date.now() + 5 * DAY).toISOString(),
    resumable: "brief",
    issueTitle: "Fix the latch",
    repositoryName: "platform",
  },
];

describe("HistoryView", () => {
  it("lists what was deleted and what was finished, saying what a resume would do", async () => {
    renderWithTrpc(<HistoryView />, { "history.list": () => entries });

    const list = await screen.findByRole("list", { name: "History" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Deleted 1d ago");
    expect(rows[0]?.textContent).toContain("conversation continues");
    expect(rows[0]?.textContent).toContain("purged in 6d");
    expect(rows[1]?.textContent).toContain("Done 2d ago");
    expect(rows[1]?.textContent).toContain("starts again from the brief");
    expect(rows[1]?.textContent).toContain("worktree removed in 5d");
  });

  it("restores a deleted task through task.restore", async () => {
    const { log } = renderWithTrpc(<HistoryView />, {
      "history.list": () => entries,
      "task.restore": () => task({ id: "task-deleted", state: "failed" }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(log.calls.filter((c) => c.path === "task.restore")).toHaveLength(1));
    expect(log.calls.find((c) => c.path === "task.restore")?.input).toEqual({ id: "task-deleted" });
  });

  it("reopens and resumes a finished task — Ready first, then a launch — after a confirmation", async () => {
    const { log } = renderWithTrpc(<HistoryView />, {
      "history.list": () => entries,
      "workflow.list": () => [],
      "task.move": () => task({ id: "task-done", state: "ready" }),
      "task.launch": () => task({ id: "task-done", state: "running" }),
    });

    fireEvent.click(await screen.findByRole("button", { name: /Reopen & resume/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("starts from the task brief");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen and resume" }));

    await waitFor(() => expect(log.calls.filter((c) => c.path === "task.launch")).toHaveLength(1));
    expect(log.calls.find((c) => c.path === "task.move")?.input).toEqual({
      id: "task-done",
      to: "ready",
    });
    expect(log.calls.find((c) => c.path === "task.launch")?.input).toEqual({ id: "task-done" });
  });

  it("says so when there is nothing to show", async () => {
    renderWithTrpc(<HistoryView />, { "history.list": () => [] });
    expect(await screen.findByText("Nothing in history")).toBeDefined();
  });
});
