/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { TaskDto, TaskState, WorkflowStepDto } from "@solow/contracts";
import { columnIdFor, lifecycleColumns, workflowColumns } from "./board-columns";
import { BOARD_COLUMNS, STATE_LABELS, STATE_STYLE } from "./task-states";

/**
 * The board's columns as data (issue #5 AC-6).
 *
 * The first test is the regression that matters most in this change: it pins the lifecycle board
 * to `BOARD_COLUMNS`/`STATE_STYLE` *by construction*, so "the default board is unchanged" is a
 * property the suite holds rather than something a reader once eyeballed.
 */

function step(over: Partial<WorkflowStepDto> & { id: string; rank: string }): WorkflowStepDto {
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

function task(over: Partial<TaskDto> & { state: TaskState }): TaskDto {
  return {
    id: "task-1",
    issueId: "issue-1",
    title: "Investigate servo stall",
    agentProfileId: "agent-1",
    executorProfileId: "exec-1",
    repositories: [],
    failureReason: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    workflowId: null,
    workflowStepId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("lifecycleColumns", () => {
  it("is BOARD_COLUMNS, in order, with the chrome STATE_STYLE gives each state", () => {
    const columns = lifecycleColumns();
    expect(columns).toHaveLength(BOARD_COLUMNS.length);
    columns.forEach((column, index) => {
      const state = BOARD_COLUMNS[index];
      if (state === undefined) throw new Error("BOARD_COLUMNS shrank under the test");
      const style = STATE_STYLE[state];
      expect(column.kind).toBe("state");
      expect(column.id).toBe(`state:${state}`);
      expect(column).toMatchObject({
        label: STATE_LABELS[state],
        icon: style.icon,
        textClassName: style.textClassName,
        barClassName: style.barClassName,
        hint: style.hint,
        droppable: true,
      });
    });
  });

  it("hands back one stable array, so the default column list is not a new identity per render", () => {
    expect(lifecycleColumns()).toBe(lifecycleColumns());
  });
});

describe("workflowColumns", () => {
  // Ranks out of order relative to `position`, and `position` deliberately lying: the ordering
  // must come from `sortSteps` (i.e. the rank) and from nothing else, because `position` is
  // derived server-side on read and a list built from two reads can carry a stale one.
  const steps = [
    step({ id: "s2", rank: "n", name: "Implement", position: 0 }),
    step({ id: "s1", rank: "g", name: "Plan", position: 7 }),
    step({ id: "s3", rank: "t", name: "Review", position: 1 }),
  ];

  it("orders Step columns by rank, not by the position field", () => {
    const columns = workflowColumns(steps);
    expect(columns.filter((c) => c.kind === "step").map((c) => c.stepId)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    // The 1-based place shown to the operator is the place in *that* order, never `step.position`.
    expect(columns.filter((c) => c.kind === "step").map((c) => c.position)).toEqual([1, 2, 3]);
  });

  it("appends exactly one Done column and one Other work column, in that order", () => {
    const columns = workflowColumns(steps);
    expect(columns.map((c) => c.id)).toEqual([
      "step:s1",
      "step:s2",
      "step:s3",
      "state:done",
      "other",
    ]);
    expect(columns.filter((c) => c.kind === "state")).toHaveLength(1);
    expect(columns.filter((c) => c.kind === "other")).toHaveLength(1);
  });

  it("makes no Step column a drop target, and keeps Done one", () => {
    const columns = workflowColumns(steps);
    for (const column of columns.filter((c) => c.kind === "step")) {
      expect(column.droppable).toBe(false);
    }
    expect(columns.find((c) => c.id === "state:done")?.droppable).toBe(true);
    expect(columns.find((c) => c.id === "other")?.droppable).toBe(false);
  });

  it("accents a human-gated Step with the Review hue and the automatic gates with neither", () => {
    const columns = workflowColumns([
      step({ id: "h", rank: "a", gate: "human" }),
      step({ id: "a", rank: "b", gate: "auto" }),
      step({ id: "u", rank: "c", gate: "auto-unless-changes" }),
    ]);
    const byId = new Map(columns.map((c) => [c.id, c]));
    expect(byId.get("step:h")?.textClassName).toBe(STATE_STYLE.review.textClassName);
    expect(byId.get("step:a")?.textClassName).not.toBe(STATE_STYLE.review.textClassName);
    expect(byId.get("step:u")?.textClassName).not.toBe(STATE_STYLE.review.textClassName);
    // Each gate still carries its own glyph: colour alone would fail WCAG 1.4.1, which is the
    // whole reason STATE_STYLE pairs a hue with an icon.
    const icons = new Set(
      columns.filter((c) => c.kind === "step").map((c) => c.icon as unknown as object),
    );
    expect(icons.size).toBe(3);
  });
});

describe("columnIdFor", () => {
  const columns = workflowColumns([
    step({ id: "s1", rank: "g", name: "Plan" }),
    step({ id: "s2", rank: "n", name: "Implement" }),
  ]);

  it("puts a Task on a different Workflow in the Other work lane", () => {
    expect(columnIdFor(task({ state: "running", workflowId: "wf-9" }), columns)).toBe("other");
  });

  it("puts a Task on no Workflow in the Other work lane", () => {
    // The common case mid-migration: most of a Workspace's Tasks are on no Workflow at all, and
    // hiding them is how work is lost.
    expect(columnIdFor(task({ state: "running", workflowId: null }), columns)).toBe("other");
  });

  it("puts a done Task in the terminal Done column even though its cursor still names a Step", () => {
    expect(
      columnIdFor(task({ state: "done", workflowId: "wf-1", workflowStepId: "s2" }), columns),
    ).toBe("state:done");
  });

  it("keeps a done Task that belongs to another Workflow out of this board's Done column", () => {
    // Precedence, and it has to be this way round: `Done` here is the terminal column of the
    // pipeline on screen, so a finished Task from a different pipeline sitting in it would claim
    // this Workflow produced it.
    expect(
      columnIdFor(task({ state: "done", workflowId: "wf-9", workflowStepId: "x1" }), columns),
    ).toBe("other");
  });

  it("leaves a failed Task in the Step it died on", () => {
    // Deliberate: the column says where in the pipeline the work is, the badge on the card says
    // what happened to it. Teleporting a dead run out of its pipeline loses the useful half.
    expect(
      columnIdFor(task({ state: "failed", workflowId: "wf-1", workflowStepId: "s2" }), columns),
    ).toBe("step:s2");
  });

  it("puts a Task with a null cursor on the first Step", () => {
    // `resumeWorkflowCursor`'s own answer to a null cursor. The card keeps its backlog/ready
    // badge, which already says it has not started — no separate Unstarted lane is needed.
    expect(
      columnIdFor(task({ state: "backlog", workflowId: "wf-1", workflowStepId: null }), columns),
    ).toBe("step:s1");
  });

  it("falls back to the lifecycle state when the board is showing lifecycle columns", () => {
    for (const state of BOARD_COLUMNS) {
      expect(columnIdFor(task({ state }), lifecycleColumns())).toBe(`state:${state}`);
    }
  });

  it("still places a Task that is on the selected Workflow when it carries a workflowId", () => {
    // Guards the precedence: `workflowId` is compared against the Workflow the *columns* describe,
    // which is read off the Step columns rather than passed in beside them.
    expect(
      columnIdFor(task({ state: "running", workflowId: "wf-1", workflowStepId: "s2" }), columns),
    ).toBe("step:s2");
  });
});
