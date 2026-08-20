/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDto, TaskState } from "@gatecontrol/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { BOARD_COLUMNS } from "@/lib/task-states";
import { BoardView } from "./board";
import { CARD_ENTRANCE_CLASS } from "./column";

/**
 * Board rendering tests (task TASK-024). Exercises the pure presentational board with props,
 * so no tRPC/network is involved: empty columns show their empty state; Tasks land in the
 * column matching their state.
 */

function makeTask(over: Partial<TaskDto> & { id: string; state: TaskState }): TaskDto {
  return {
    issueId: "issue-1",
    title: `Task ${over.id}`,
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
    ...over,
  };
}

afterEach(cleanup);

describe("BoardView", () => {
  it("renders every lifecycle column with an empty state when there are no tasks", () => {
    render(<BoardView tasks={[]} />);
    expect(screen.getAllByText(/^No tasks in/)).toHaveLength(BOARD_COLUMNS.length);
    // Column headings are present.
    expect(screen.getByText("Backlog")).toBeDefined();
    expect(screen.getByText("Review")).toBeDefined();
  });

  it("renders a Task card in the column matching its state", () => {
    render(
      <BoardView
        tasks={[
          makeTask({ id: "1", state: "running", title: "Fix the gate latch" }),
          makeTask({ id: "2", state: "backlog", title: "Investigate servo" }),
        ]}
      />,
    );
    expect(screen.getByText("Fix the gate latch")).toBeDefined();
    expect(screen.getByText("Investigate servo")).toBeDefined();
    // Only 5 of 7 columns remain empty (backlog + running now populated).
    expect(screen.getAllByText(/^No tasks in/)).toHaveLength(BOARD_COLUMNS.length - 2);
  });

  it("shows a failure reason on a failed Task card", () => {
    render(
      <BoardView
        tasks={[makeTask({ id: "3", state: "failed", failureReason: "credential_expired" })]}
      />,
    );
    expect(screen.getByText("credential_expired")).toBeDefined();
  });

  it("renders per-Task actions supplied by renderActions", () => {
    render(
      <BoardView
        tasks={[makeTask({ id: "4", state: "ready", title: "Launchable" })]}
        renderActions={(t) => <button type="button">act-{t.id}</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "act-4" })).toBeDefined();
  });

  it("wraps a card's <li> in the entrance-transition utility classes (user report: animate a card moving between columns)", () => {
    render(<BoardView tasks={[makeTask({ id: "5", state: "backlog", title: "Fresh card" })]} />);
    const item = screen.getByText("Fresh card").closest("li");
    expect(item).not.toBeNull();
    for (const cls of CARD_ENTRANCE_CLASS.split(" ")) {
      expect(item?.className).toContain(cls);
    }
  });

  it("renders a column's headerAction inside that column only", () => {
    render(
      <BoardView
        tasks={[]}
        headerActionFor={(state) =>
          state === "backlog" ? <button type="button">New issue</button> : null
        }
      />,
    );
    const button = screen.getByRole("button", { name: "New issue" });
    expect(button.closest("[data-state='backlog']")).not.toBeNull();
    expect(button.closest("[data-state='ready']")).toBeNull();
  });
});
