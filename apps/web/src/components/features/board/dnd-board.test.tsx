/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDto, WorkflowStepDto } from "@solow/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { lifecycleColumns, workflowColumns } from "@/lib/board-columns";
import { CARD_ENTRANCE_CLASS } from "./column";
import { boardAnnouncements, DndBoard, resolveDrop } from "./dnd-board";

/**
 * The drag-and-drop board's entrance animation (user report: "should the board animate a card
 * moving between columns"). A style/class assertion, not a real animation-timing test — the
 * behaviour under test is "the card's list-item wrapper carries the entrance utility classes",
 * which is what would silently regress if someone dropped the className during a refactor.
 */
function makeTask(over: Partial<TaskDto> = {}): TaskDto {
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

function makeStep(over: Partial<WorkflowStepDto> & { id: string; rank: string }): WorkflowStepDto {
  return {
    workflowId: "wf-1",
    name: `Step ${over.id}`,
    position: 0,
    agentProfileId: "agent-1",
    promptTemplate: "do the thing",
    gate: "human",
    advanceOn: "review",
    onEnter: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const STEPS = [
  makeStep({ id: "s1", rank: "g", name: "Plan" }),
  makeStep({ id: "s2", rank: "n", name: "Implement" }),
];

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

/**
 * Where a drop lands (issue #5 AC-6).
 *
 * Asserted through `resolveDrop` rather than by driving a real drag: every element in this test
 * environment measures 0×0, so dnd-kit's collision detection never picks a droppable and a
 * "drag" here would pass no matter what the handler did. `resolveDrop` is the whole decision the
 * handler makes, and `handleEnd` calls nothing else — so this is the rule under test, not a
 * restatement of it.
 */
describe("resolveDrop", () => {
  it("moves a card between two lifecycle columns, unchanged from before Workflows existed", () => {
    expect(resolveDrop("state:review", "running", lifecycleColumns())).toEqual({
      kind: "move",
      to: "review",
    });
  });

  it("refuses a drop on a Step column and asks for no move at all", () => {
    /*
     * The Principle I bypass this change exists to close. A drop that reached `task.move` with a
     * Step id would have written a pipeline position through the lifecycle machine: no gate
     * evaluated, no approval spent, no handoff promoted, no decision recorded.
     */
    const resolution = resolveDrop("step:s2", "running", workflowColumns(STEPS));
    expect(resolution.kind).toBe("refused");
    expect(resolution.kind === "refused" && resolution.column.id).toBe("step:s2");
  });

  it("refuses a drop on the Other work lane too", () => {
    const resolution = resolveDrop("other", "running", workflowColumns(STEPS));
    expect(resolution.kind).toBe("refused");
  });

  it("still moves onto the Done column of a Workflow board — the one lifecycle column it has", () => {
    expect(resolveDrop("state:done", "review", workflowColumns(STEPS))).toEqual({
      kind: "move",
      to: "done",
    });
  });

  it("does nothing when the card is dropped back where it started, or on an unknown target", () => {
    expect(resolveDrop("state:running", "running", lifecycleColumns())).toEqual({ kind: "none" });
    expect(resolveDrop("running", "backlog", lifecycleColumns())).toEqual({ kind: "none" });
  });
});

describe("DndBoard in Workflow mode", () => {
  const onStep = makeTask({ workflowId: "wf-1", workflowStepId: "s2", state: "failed" });

  it("gives a card in a Step column no drag grip, so no drag can even begin there", () => {
    render(<DndBoard tasks={[onStep]} columns={workflowColumns(STEPS)} onMove={() => {}} />);
    expect(screen.queryByRole("button", { name: `Move ${onStep.title}` })).toBeNull();
  });

  it("keeps the grip on a card in the Done column, which is a real lifecycle column", () => {
    const done = makeTask({ id: "task-2", title: "Landed", workflowId: "wf-1", state: "done" });
    render(<DndBoard tasks={[done]} columns={workflowColumns(STEPS)} onMove={() => {}} />);
    expect(screen.getByRole("button", { name: "Move Landed" })).toBeDefined();
  });

  it("leaves a failed Task on the Step it died on, and says so on the card", () => {
    render(<DndBoard tasks={[onStep]} columns={workflowColumns(STEPS)} onMove={() => {}} />);
    const column = screen.getByLabelText("2 · Implement column");
    expect(within(column).getByText(onStep.title)).toBeDefined();
    // The column says where in the pipeline; the badge says what happened to the run.
    expect(within(column).getByText("Failed")).toBeDefined();
  });

  it("renders the Other work lane only when something is in it, naming the workflow each card is on", () => {
    const stray = makeTask({ id: "task-9", title: "Elsewhere", workflowId: "wf-2" });
    const { rerender } = render(
      <DndBoard tasks={[onStep]} columns={workflowColumns(STEPS)} onMove={() => {}} />,
    );
    expect(screen.queryByLabelText("Other work column")).toBeNull();

    rerender(
      <DndBoard
        tasks={[onStep, stray]}
        columns={workflowColumns(STEPS)}
        onMove={() => {}}
        workflowNameFor={(id) => (id === "wf-2" ? "Docs pipeline" : null)}
      />,
    );
    const other = screen.getByLabelText("Other work column");
    expect(within(other).getByText("Elsewhere")).toBeDefined();
    expect(within(other).getByText("Docs pipeline")).toBeDefined();
  });
});

describe("DndBoard in lifecycle mode", () => {
  it("draws exactly the seven lifecycle columns, with no Workflow chrome anywhere", () => {
    render(<DndBoard tasks={[makeTask()]} onMove={() => {}} />);
    const sections = screen.getAllByLabelText(/ column$/);
    expect(sections.map((s) => s.getAttribute("data-column"))).toEqual(
      lifecycleColumns().map((c) => c.id),
    );
    // `data-state` survives on every lifecycle column, and only there.
    expect(sections.every((s) => s.getAttribute("data-state") !== null)).toBe(true);
    // No state pill on the card: the column it sits in already says that.
    expect(screen.queryByText("Backlog", { selector: "[data-task-state]" })).toBeNull();
  });

  /**
   * What a screen reader hears, which changed under this feature without anything visual moving.
   *
   * Column ids used to be bare `TaskState` strings, so @dnd-kit's default announcements read
   * "dropped over droppable area ready". Once ids became `state:ready` — needed so a Step id and
   * a state id cannot collide — the same live region began reading "state:ready" aloud on the
   * lifecycle board, which is every board in a Workspace with no Workflows.
   *
   * Asserted against `boardAnnouncements` directly, not by rendering. The live region is empty
   * until a drag starts and @dnd-kit's drag cannot be driven here, so a test that rendered the
   * board and searched its text would pass with the announcements unwired — verified, it did.
   */
  it("announces the column a card is over by its label, never by its id", () => {
    const task = makeTask({ id: "task-1", title: "Replace the latch" });
    const columns = lifecycleColumns();
    const ready = columns.find((column) => column.kind === "state" && column.state === "ready");
    if (!ready) throw new Error("no ready column");

    const announce = boardAnnouncements(columns, [task]);
    const over = announce.onDragOver({ active: { id: "task-1" }, over: { id: ready.id } });

    expect(over).toContain(ready.label);
    expect(over).toContain("Replace the latch");
    expect(over).not.toContain(ready.id);

    const dropped = announce.onDragEnd({ active: { id: "task-1" }, over: { id: ready.id } });
    expect(dropped).toContain(ready.label);
    expect(dropped).not.toContain(ready.id);

    // A drop outside every column says so, rather than naming nothing and reading as a success.
    expect(announce.onDragEnd({ active: { id: "task-1" }, over: null })).toContain("nothing moved");
  });
});
