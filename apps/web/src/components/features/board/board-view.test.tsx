/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDto, TaskState } from "@solow/contracts";
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
    agentProfileId: "harness-1",
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
    // A Task on no Workflow — every Task while `ff-workflows` is off (issue #5).
    workflowId: null,
    workflowStepId: null,
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

  it("names an unrecognised failure reason instead of printing its class", () => {
    // The reasons with a next step of their own are drawn individually below; everything else
    // used to fall through to a badge rendering the raw class in monospace. An Owner can do
    // nothing with `some_generic_failure`, so the badge says what happened — and keeps the class
    // announced, for whoever is debugging a reason this build does not know yet.
    render(
      <BoardView
        tasks={[makeTask({ id: "3", state: "failed", failureReason: "some_generic_failure" })]}
      />,
    );
    expect(screen.getByText("Run failed")).toBeDefined();
    expect(screen.queryByText("some_generic_failure")).toBeNull();
    expect(screen.getByText(/reason: some_generic_failure/)).toBeDefined();
  });

  it("reads a Task parked past its window in the parked voice, not as a failure", () => {
    // `park_never_resumed` is written by the orchestrator's sweep onto a Task that slept through
    // its quota window, so this is the reason that actually reached the raw-string badge in
    // practice. It belongs to `parked`, and painting it in the failed red would contradict the
    // state badge sitting beside it.
    render(
      <BoardView
        tasks={[makeTask({ id: "3a", state: "parked", failureReason: "park_never_resumed" })]}
      />,
    );
    expect(screen.getByText("Never resumed")).toBeDefined();
    expect(screen.queryByText("park_never_resumed")).toBeNull();
  });

  it("shows an expired credential distinctly, not as the raw failure class (spec AC-013)", () => {
    // A reviewer scanning the board should not have to know what "credential_expired" means —
    // this is the one failure reason with a one-click fix, so it reads as a sentence.
    render(
      <BoardView
        tasks={[makeTask({ id: "3b", state: "failed", failureReason: "credential_expired" })]}
      />,
    );
    expect(screen.getByText("Credential expired")).toBeDefined();
    expect(screen.queryByText("credential_expired")).toBeNull();
  });

  it("shows a Task the orchestrator reclaimed after a restart distinctly (issue: input answered 'no harness running' forever)", () => {
    render(
      <BoardView tasks={[makeTask({ id: "3c", state: "failed", failureReason: "interrupted" })]} />,
    );
    expect(screen.getByText("Interrupted by restart")).toBeDefined();
    expect(screen.queryByText("interrupted")).toBeNull();
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
});
