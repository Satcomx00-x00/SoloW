/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDto } from "@gatecontrol/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { CARD_ENTRANCE_CLASS } from "./column";
import { DndBoard } from "./dnd-board";

/**
 * The drag-and-drop board's entrance animation (user report: "should the board animate a card
 * moving between columns"). A style/class assertion, not a real animation-timing test — the
 * behaviour under test is "the card's list-item wrapper carries the entrance utility classes",
 * which is what would silently regress if someone dropped the className during a refactor.
 */
function makeTask(): TaskDto {
  return {
    id: "task-1",
    issueId: "issue-1",
    title: "Investigate servo stall",
    state: "backlog",
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

afterEach(cleanup);

describe("DndBoard card entrance transition", () => {
  it("wraps a rendered card's <li> in the entrance-transition utility classes", () => {
    render(<DndBoard tasks={[makeTask()]} onMove={() => {}} />);

    const item = screen.getByText("Investigate servo stall").closest("li");
    expect(item).not.toBeNull();
    for (const cls of CARD_ENTRANCE_CLASS.split(" ")) {
      expect(item?.className).toContain(cls);
    }
  });
});
