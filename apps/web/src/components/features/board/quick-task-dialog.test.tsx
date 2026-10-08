/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { TaskErrorCode } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { WHOLE_PAGE } from "@/lib/paged";
import { renderWithTrpc } from "@/test/trpc-harness";
import { trpc } from "@/trpc/react";
import { QuickTaskDialog } from "./quick-task-dialog";

afterEach(cleanup);

const repo = (id: string, name: string) => ({
  id,
  name,
  source: "local_path",
  location: `/srv/${name}`,
  integrationId: null,
  externalFullName: null,
  provider: null,
  integrationBaseUrl: null,
  issueCount: 0,
  usage: { taskCount: 0, projectCount: 0, changeRequestCount: 0 },
  setupFilePatterns: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const readyTask = { id: "task-9", state: "ready" };

/** Something on the page that lists Tasks, so a refetch after the write is visible in the log. */
function TaskList() {
  trpc.task.list.useQuery({ ...WHOLE_PAGE });
  return null;
}

describe("QuickTaskDialog", () => {
  it("says the Task exists but did not start, links to it, and cannot make it twice", async () => {
    const { log } = renderWithTrpc(
      <>
        <TaskList />
        <QuickTaskDialog open onOpenChange={() => {}} />
      </>,
      {
        "repository.list": () => ({ items: [repo("repo-1", "gate")], nextCursor: null }),
        "task.list": () => ({ items: [], nextCursor: null }),
        "task.quickStart": () => ({
          task: readyTask,
          issueId: "issue-9",
          started: false,
          reason: TaskErrorCode.ConcurrencyCapReached,
        }),
      },
    );

    fireEvent.change(screen.getByLabelText("What should the agent do?"), {
      target: { value: "Add a farewell() helper" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Task created but not started");
    expect(alert.textContent).toContain("already running as many tasks as it allows");
    const link = screen.getByRole("link", { name: "Open the task" });
    expect(link.getAttribute("href")).toBe("/task/task-9");
    // The sentence went into the Task that now exists; the same click again would copy it.
    expect((screen.getByLabelText("What should the agent do?") as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect((screen.getByRole("button", { name: "Start task" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // The board learns about the Task and its Issue without a reload.
    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === "task.list").length).toBeGreaterThan(1),
    );
  });
});
