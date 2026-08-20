/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDto, TaskRepositoryDto } from "@gatecontrol/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { CreateTaskDialog } from "./create-task-dialog";
import { TaskCard } from "./task-card";

/**
 * Multi-repository Tasks in the board UI (issue #7).
 *
 * Two questions: does the create form actually send an attachment per repository the Owner
 * ticked, in the order that decides which one the agent runs in — and does a card say that a
 * Task spans more than one repository, given it only has room to name one branch.
 */

function attachment(over: Partial<TaskRepositoryDto> = {}): TaskRepositoryDto {
  return {
    id: "attach-1",
    repositoryId: "repo-1",
    baseRef: null,
    checkoutBranch: "gatecontrol/task-1",
    resultBranch: null,
    position: 0,
    ...over,
  };
}

function task(repositories: TaskRepositoryDto[]): TaskDto {
  return {
    id: "task-1",
    issueId: "issue-1",
    title: "Cross-repository change",
    state: "review",
    agentProfileId: "agent-1",
    executorProfileId: "exec-1",
    repositories,
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(cleanup);

describe("TaskCard with several Repositories", () => {
  it("shows how many Repositories the Task spans", async () => {
    renderWithTrpc(
      <TaskCard
        task={task([
          attachment({ resultBranch: "gatecontrol/task-1" }),
          attachment({ id: "attach-2", repositoryId: "repo-2", position: 1 }),
        ])}
      />,
    );

    expect(await screen.findByLabelText("2 repositories")).toBeDefined();
  });

  it("says nothing about repository count for a single-Repository Task", async () => {
    renderWithTrpc(<TaskCard task={task([attachment()])} />);

    await screen.findByText("Cross-repository change");
    expect(screen.queryByLabelText("1 repositories")).toBeNull();
  });

  it("names the branch of the attachment the agent actually ran in", async () => {
    // Position, not array order: a re-sorted list must not change which branch the card names.
    renderWithTrpc(
      <TaskCard
        task={task([
          attachment({ id: "attach-2", repositoryId: "repo-2", position: 1, resultBranch: "lib" }),
          attachment({ resultBranch: "gatecontrol/task-1", position: 0 }),
        ])}
      />,
    );

    expect(await screen.findByText("gatecontrol/task-1")).toBeDefined();
    expect(screen.queryByText("lib")).toBeNull();
  });
});

describe("creating a Task across several Repositories", () => {
  const handlers = {
    "issue.list": () => [
      { id: "issue-1", title: "Ship it", description: null, status: "open", taskCount: 0 },
    ],
    "profile.agent.list": () => [{ id: "agent-1", name: "Claude" }],
    "profile.executor.list": () => [{ id: "exec-1", name: "Local" }],
    "repository.list": () => [
      { id: "repo-1", name: "api", source: "local_path", location: "/srv/api" },
      { id: "repo-2", name: "shared-lib", source: "local_path", location: "/srv/lib" },
    ],
    "task.create": () => task([attachment()]),
    "task.list": () => [],
  };

  /** Pick an option out of one of the dialog's Selects, the way the e2e suite does. */
  async function pick(label: string, option: string): Promise<void> {
    fireEvent.click(await screen.findByRole("combobox", { name: label }));
    fireEvent.click(await screen.findByRole("option", { name: option }));
  }

  it("sends one attachment per repository, the chosen one first", async () => {
    const { log } = renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    fireEvent.change(await screen.findByLabelText("Title"), {
      target: { value: "Cross-repository change" },
    });
    await pick("Issue", "Ship it");
    await pick("Agent profile", "Claude");
    await pick("Executor", "Local");
    await pick("Repository", "api");
    fireEvent.change(screen.getByLabelText("Base ref"), { target: { value: "main" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "shared-lib" }));
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "task.create")).toBe(true);
    });
    const sent = log.calls.find((c) => c.path === "task.create")?.input as {
      repositories: Array<{ repositoryId: string; baseRef?: string }>;
    };
    // Array order becomes `position`, and position 0 is the worktree the agent is started in —
    // so the repository the Owner selected has to come first, with its own base ref.
    expect(sent.repositories).toEqual([
      { repositoryId: "repo-1", baseRef: "main" },
      { repositoryId: "repo-2" },
    ]);
  });

  it("sends a single attachment when nothing else is ticked", async () => {
    const { log } = renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "One repo" } });
    await pick("Issue", "Ship it");
    await pick("Agent profile", "Claude");
    await pick("Executor", "Local");
    await pick("Repository", "api");
    fireEvent.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "task.create")).toBe(true);
    });
    const sent = log.calls.find((c) => c.path === "task.create")?.input as {
      repositories: Array<{ repositoryId: string }>;
    };
    expect(sent.repositories).toEqual([{ repositoryId: "repo-1" }]);
  });
});
