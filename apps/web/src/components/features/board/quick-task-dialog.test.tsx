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

const harness = (id: string, permissionMode: string, createdAt: string) => ({
  id,
  name: id,
  permissionMode,
  createdAt,
});
const executor = (id: string, kind: string, createdAt: string) => ({
  id,
  name: id,
  kind,
  createdAt,
});
const noDefaults = () => ({
  workspaceId: "ws-1",
  userId: "user-1",
  defaults: { harnessProfileId: null, executorProfileId: null },
});
/** Profiles the dialog reads to know what the server will pick; a safe pairing by default. */
const profiles = {
  "profile.agent.list": () => ({
    items: [harness("h-1", "acceptEdits", "2026-01-01T00:00:00.000Z")],
    nextCursor: null,
  }),
  "profile.executor.list": () => ({
    items: [executor("x-1", "docker", "2026-01-01T00:00:00.000Z")],
    nextCursor: null,
  }),
  "preference.getTaskDefaults": noDefaults,
};

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
        ...profiles,
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

  it("asks which repository when there are several, rather than choosing the first", async () => {
    const { log } = renderWithTrpc(<QuickTaskDialog open onOpenChange={() => {}} />, {
      ...profiles,
      "repository.list": () => ({
        items: [repo("repo-1", "gate"), repo("repo-2", "docs")],
        nextCursor: null,
      }),
    });

    await screen.findByText("Choose a repository");
    fireEvent.change(screen.getByLabelText("What should the agent do?"), {
      target: { value: "Fix the latch" },
    });
    const startButton = screen.getByRole("button", { name: "Start task" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);
    fireEvent.click(startButton);
    expect(log.calls.some((c) => c.path === "task.quickStart")).toBe(false);
  });

  it("warns before a never-ask harness runs on the host, for the profiles it will use", async () => {
    renderWithTrpc(<QuickTaskDialog open onOpenChange={() => {}} />, {
      "repository.list": () => ({ items: [repo("repo-1", "gate")], nextCursor: null }),
      // The oldest harness never asks; the newer one would. No container, so the host it is.
      "profile.agent.list": () => ({
        items: [
          harness("h-new", "acceptEdits", "2026-05-01T00:00:00.000Z"),
          harness("h-old", "bypassPermissions", "2026-01-01T00:00:00.000Z"),
        ],
        nextCursor: null,
      }),
      "profile.executor.list": () => ({
        items: [executor("x-local", "local", "2026-01-01T00:00:00.000Z")],
        nextCursor: null,
      }),
      "preference.getTaskDefaults": noDefaults,
    });

    expect(await screen.findByText("This run is not isolated")).toBeTruthy();
  });

  it("does not warn when a container is there to run it", async () => {
    renderWithTrpc(<QuickTaskDialog open onOpenChange={() => {}} />, {
      "repository.list": () => ({ items: [repo("repo-1", "gate")], nextCursor: null }),
      "profile.agent.list": () => ({
        items: [harness("h-old", "bypassPermissions", "2026-01-01T00:00:00.000Z")],
        nextCursor: null,
      }),
      "profile.executor.list": () => ({
        items: [
          executor("x-local", "local", "2026-01-01T00:00:00.000Z"),
          executor("x-docker", "docker", "2026-05-01T00:00:00.000Z"),
        ],
        nextCursor: null,
      }),
      "preference.getTaskDefaults": noDefaults,
    });

    await screen.findByLabelText("What should the agent do?");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("This run is not isolated")).toBeNull();
  });
});
