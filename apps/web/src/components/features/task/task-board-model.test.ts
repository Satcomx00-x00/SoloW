/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { DecisionWidget, SessionEventDto, TaskEvent, WorkflowStepDto } from "@solow/contracts";
import {
  boardColumns,
  boardTally,
  needsYouCount,
  passOf,
  RUN_COLUMN_ID,
  type StepHistory,
  stepFacts,
} from "./task-board-model";
import type { PermissionRow, TranscriptRow } from "./transcript";
import type { SteppedStep } from "./workflow-steps";

const SESSION = "sess-1";

function stepped(
  rows: Array<[id: string, name: string, status: SteppedStep["status"], current?: boolean]>,
): SteppedStep[] {
  return rows.map(([id, name, status, current = false], position) => ({
    step: { id, name, position } as WorkflowStepDto,
    status,
    current,
  }));
}

function persisted(seq: number, payload: SessionEventDto["payload"], step?: string | null) {
  return {
    id: `ev-${seq}`,
    sessionId: SESSION,
    seq,
    kind: payload.kind,
    payload,
    workflowStepId: step ?? null,
    at: "2026-01-01T00:00:00.000Z",
  } as SessionEventDto;
}

const decision = (id: string, question: string): DecisionWidget => ({
  kind: "decision",
  id,
  question,
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  chosen: "a",
});

function permission(seq: number, step: string | null, open = true): PermissionRow {
  return {
    kind: "permission",
    id: `${SESSION}:${seq}`,
    sessionId: SESSION,
    seq,
    requestId: `req-${seq}`,
    title: "Write .env",
    toolKind: "edit",
    toolCallId: null,
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    workflowStepId: step,
    resolution: open ? null : { optionId: "once", decidedBy: "operator" },
  };
}

const STEPS = stepped([
  ["plan", "Plan", "done"],
  ["impl", "Implement", "running", true],
  ["test", "Test", "upcoming"],
]);

describe("boardColumns", () => {
  it("draws one column per Step, in order, with the cursor's Step current", () => {
    const columns = boardColumns({
      stepped: STEPS,
      state: "running",
      home: null,
      facts: stepFacts([], [], SESSION),
      rows: [],
      showGate: false,
    });
    expect(columns.map((c) => [c.name, c.status, c.current])).toEqual([
      ["Plan", "done", false],
      ["Implement", "running", true],
      ["Test", "upcoming", false],
    ]);
  });

  it("gives a Task on no Workflow one Run column, coloured by the Task's state", () => {
    const columns = boardColumns({
      stepped: [],
      state: "failed",
      home: null,
      facts: stepFacts([], [], SESSION),
      rows: [],
      showGate: true,
    });
    expect(columns).toHaveLength(1);
    expect(columns[0]).toMatchObject({ id: RUN_COLUMN_ID, name: "Run", status: "failed" });
    expect(columns[0]?.items.map((i) => i.kind)).toEqual(["gate"]);
  });

  it("files each item under the Step it came from, and the unattributed under the Step on screen", () => {
    const facts = stepFacts(
      [
        persisted(
          0,
          {
            kind: "widget",
            widgetId: "w-0",
            widget: { kind: "step_card", title: "GitHub first", steps: [] },
          },
          "plan",
        ),
        persisted(
          1,
          { kind: "widget", widgetId: "w-1", widget: decision("d-1", "Sessions?") },
          "plan",
        ),
        persisted(
          2,
          { kind: "todos", items: [{ content: "oauth", status: "in_progress" }] },
          "impl",
        ),
        // From an orchestrator older than Steps: no attribution at all.
        persisted(3, { kind: "widget", widgetId: "w-3", widget: decision("d-2", "Expiry?") }, null),
      ],
      [],
      SESSION,
    );
    const columns = boardColumns({
      stepped: STEPS,
      state: "running",
      home: null,
      facts,
      rows: [permission(4, "impl")],
      showGate: false,
    });
    const kinds = (id: string) => columns.find((c) => c.id === id)?.items.map((i) => i.kind);
    expect(kinds("plan")).toEqual(["plan", "decisions"]);
    // Standing state first; the rest in arrival order (both here, so only membership is asserted).
    expect(kinds("impl")?.[0]).toBe("todos");
    expect([...(kinds("impl") ?? [])].sort()).toEqual(["decisions", "permission", "todos"]);
    expect(kinds("test")).toEqual([]);
  });

  it("puts the unattributed under the Step the operator picked, when they picked one", () => {
    const columns = boardColumns({
      stepped: STEPS,
      state: "running",
      home: "plan",
      facts: stepFacts([], [], SESSION),
      rows: [permission(1, null)],
      showGate: false,
    });
    expect(columns.find((c) => c.id === "plan")?.items.map((i) => i.kind)).toEqual(["permission"]);
  });

  it("orders decisions and questions by arrival, and always ends the current Step on its gate", () => {
    const rows: TranscriptRow[] = [
      permission(1, "impl", false),
      {
        kind: "widget",
        id: `${SESSION}:2`,
        sessionId: SESSION,
        seq: 2,
        widgetId: "w-2",
        widget: decision("d-1", "Expiry?"),
        workflowStepId: "impl",
        response: null,
      },
      permission(3, "impl"),
    ];
    const facts = stepFacts(
      [
        persisted(
          2,
          { kind: "widget", widgetId: "w-2", widget: decision("d-1", "Expiry?") },
          "impl",
        ),
      ],
      [],
      SESSION,
    );
    const columns = boardColumns({
      stepped: STEPS,
      state: "running",
      home: null,
      facts,
      rows,
      showGate: true,
    });
    const impl = columns.find((c) => c.id === "impl");
    expect(impl?.items.map((i) => i.key)).toEqual([
      `permission:${SESSION}:req-1`,
      "decisions:impl",
      `permission:${SESSION}:req-3`,
      "gate",
    ]);
    // The settled permission is a record; the open one and the gate wait on a person.
    expect(needsYouCount(columns, "running")).toBe(2);
  });
});

describe("stacking", () => {
  it("stacks a Step's decisions into one node where the first arrived, and its questions into another", () => {
    const ask = (seq: number, prompt: string): TranscriptRow => ({
      kind: "widget",
      id: `${SESSION}:${seq}`,
      sessionId: SESSION,
      seq,
      widgetId: `ask-${seq}`,
      widget: {
        kind: "ask_user_input",
        prompt,
        mode: "single",
        options: [{ id: "a", label: "A" }],
      } as never,
      workflowStepId: "impl",
      response: seq === 5 ? { values: ["a"], text: null } : null,
    });
    const facts = stepFacts(
      [1, 2, 3].map((n) =>
        persisted(
          n,
          { kind: "widget", widgetId: `w-${n}`, widget: decision(`d-${n}`, `Q${n}?`) },
          "impl",
        ),
      ),
      [],
      SESSION,
    );
    const columns = boardColumns({
      stepped: STEPS,
      state: "running",
      home: null,
      facts,
      rows: [ask(4, "Which provider?"), ask(5, "Which scope?")],
      showGate: false,
    });
    const impl = columns.find((c) => c.id === "impl");
    expect(impl?.items.map((i) => i.key)).toEqual(["asks:impl", "decisions:impl"]);
    const decisions = impl?.items.find((i) => i.kind === "decisions");
    expect(decisions?.kind === "decisions" && decisions.widgets.map((w) => w.id)).toEqual([
      "d-1",
      "d-2",
      "d-3",
    ]);
    // One of the two questions is still open, so the stack waits on a person.
    expect(needsYouCount(columns, "running")).toBe(1);
    expect(boardTally(columns).decisions).toBe(3);
  });
});

describe("stepFacts", () => {
  it("lets the live list win, but only from the Session on screen", () => {
    const live = [
      {
        kind: "todos",
        taskId: "t",
        sessionId: "older-round",
        seq: 99,
        items: [{ content: "stale", status: "pending" }],
      },
      {
        kind: "todos",
        taskId: "t",
        sessionId: SESSION,
        seq: 5,
        workflowStepId: "impl",
        items: [
          { content: "a", status: "completed" },
          { content: "b", status: "pending" },
        ],
      },
    ] as TaskEvent[];
    const facts = stepFacts(
      [persisted(1, { kind: "todos", items: [{ content: "old", status: "pending" }] }, "impl")],
      live,
      SESSION,
    );
    expect(facts.todos.get("impl")?.map((t) => t.content)).toEqual(["a", "b"]);
    expect(facts.todos.get(null)).toBeUndefined();

    const columns = boardColumns({
      stepped: STEPS,
      state: "running",
      home: null,
      facts,
      rows: [],
      showGate: false,
    });
    expect(boardTally(columns).todos).toEqual({ done: 1, of: 2 });
  });
});

describe("passes, when the Workflow loops", () => {
  // Implement → Review → (Review sends it back) → Implement, now at its gate: the run on the
  // Task this was written for. Review's plan is from its one pass, before the loop.
  const LOOP = stepped([
    ["impl", "Implement", "waiting", true],
    ["rev", "Review", "upcoming"],
  ]);
  const decision = (seq: number, stepId: string, nextStepId: string | null) => ({
    sessionId: SESSION,
    seq,
    stepId,
    status: "advanced" as const,
    nextStepId,
    needsApproval: false,
  });
  const history: StepHistory = {
    decisions: [decision(10, "impl", "rev"), decision(20, "rev", "impl")],
    sessionOrder: new Map([[SESSION, 0]]),
  };

  it("counts a Step's passes and marks the one the loop went back past as having run", () => {
    const facts = stepFacts(
      [
        persisted(
          15,
          {
            kind: "widget",
            widgetId: "w-15",
            widget: { kind: "step_card", title: "Review", steps: [] },
          },
          "rev",
        ),
      ],
      [],
      SESSION,
    );
    const columns = boardColumns({
      stepped: LOOP,
      state: "review",
      home: null,
      facts,
      rows: [],
      showGate: true,
      history,
    });
    const [impl, rev] = columns;
    expect(impl).toMatchObject({ passes: 2, ranBefore: false });
    expect(rev).toMatchObject({ passes: 1, ranBefore: true });
    // Each card says which pass it came from, so Review's plan is read as history.
    expect(rev?.items.map((i) => [i.kind, i.pass])).toEqual([["plan", 1]]);
    expect(impl?.items.map((i) => [i.kind, i.pass])).toEqual([["gate", 2]]);
  });

  it("says nothing about passes for a run that went straight through", () => {
    const columns = boardColumns({
      stepped: stepped([
        ["impl", "Implement", "done"],
        ["rev", "Review", "running", true],
      ]),
      state: "running",
      home: null,
      facts: stepFacts([], [], SESSION),
      rows: [],
      showGate: false,
      history: { decisions: [decision(10, "impl", "rev")], sessionOrder: new Map([[SESSION, 0]]) },
    });
    expect(columns.map((c) => [c.passes, c.ranBefore])).toEqual([
      [1, false],
      [1, false],
    ]);
  });

  it("files an event under the pass it happened in, across Sessions", () => {
    const across: StepHistory = {
      decisions: [decision(10, "impl", "rev"), { ...decision(3, "rev", "impl"), sessionId: "s2" }],
      sessionOrder: new Map([
        [SESSION, 0],
        ["s2", 1],
      ]),
    };
    expect(passOf(across, "impl", { sessionId: SESSION, seq: 5 })).toBe(1);
    expect(passOf(across, "impl", { sessionId: "s2", seq: 9 })).toBe(2);
    expect(passOf(across, "rev", { sessionId: "s2", seq: 1 })).toBe(1);
  });
});
