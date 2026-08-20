/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { IssueDto, TaskDependencyDto, TaskDto, TaskState } from "@gatecontrol/contracts";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { IssueDetail } from "./issue-detail";

/**
 * The Issue view shows the same Tasks the board does, grouped by intent instead of by lifecycle.
 * A Task that is blocked on the board is blocked here — reading readiness off one route and not
 * the other is how an Owner comes to believe work is ready to run when it is not (issue #6 AC-4).
 */

const issue: IssueDto = {
  id: "issue-1",
  title: "Fix the latch",
  description: null,
  status: "open",
  taskCount: 1,
  source: "local",
  repositoryId: null,
  externalNumber: null,
  externalUrl: null,
  syncedAt: null,
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
        checkoutBranch: "gatecontrol/task-1",
        resultBranch: null,
        position: 0,
      },
    ],
    failureReason: null,
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
      "task.list": () => [makeTask("a", "ready", "Wire the latch")],
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
      "task.list": () => [makeTask("a", "ready", "Wire the latch")],
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
      "task.list": () => [makeTask("a", "ready", "Wire the latch")],
      "task.dependencies": () => {
        throw new Error("edges unavailable");
      },
    });

    expect((await screen.findByRole("alert")).textContent).toContain("edges unavailable");
    expect(screen.queryByText("Wire the latch")).toBeNull();
  });
});
