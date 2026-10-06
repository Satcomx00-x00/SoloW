import type {
  DecisionWidget,
  SessionEventDto,
  TaskEvent,
  TaskState,
  TaskStepDecisionDto,
  TodoItem,
} from "@solow/contracts";
import type { StepStatus } from "@/components/ui/steps";
import type { StepCardWidget } from "./todo-list";
import type { PermissionRow, TranscriptRow, WidgetRow } from "./transcript";
import type { SteppedStep } from "./workflow-steps";

/**
 * The task board's shape: one column per Workflow Step, and beneath each Step what the harness
 * published while it was on it — its plan, its todo list, the decisions it made, and every
 * question waiting on a person — with the gate at the foot of the Step the Task is at.
 *
 * Pure, like `transcript.ts`, so the filing rules are unit-testable without a canvas. Nothing
 * here is new information: every item is something the page already read from the stream, put
 * where it happened instead of in a log or a tab.
 */

/** A question the harness asked through the widget channel and a person answers. */
const ASK_KINDS = new Set(["ask_user_input", "options_card"]);

/** Which pass of its Step a card came from, when the Workflow has looped; absent otherwise. */
type Passed = { pass?: number };

export type BoardItem = Passed &
  (
    | { kind: "plan"; key: string; widget: StepCardWidget }
    | { kind: "todos"; key: string; items: readonly TodoItem[] }
    /** Every decision the harness made on a Step, as one stacked node: one dialog settles them all. */
    | { kind: "decisions"; key: string; widgets: DecisionWidget[] }
    | { kind: "permission"; key: string; row: PermissionRow }
    /** Every question the harness asked on a Step, stacked the same way. */
    | { kind: "asks"; key: string; rows: WidgetRow[] }
    | { kind: "gate"; key: string }
  );

export interface BoardColumn {
  /** The Step's id, or `RUN_COLUMN_ID` for a Task on no Workflow. */
  id: string;
  name: string;
  status: StepStatus;
  /** The Step the Task's cursor is on. */
  current: boolean;
  /** How many times the Step has run, the one under way included; 0 for one never reached. */
  passes: number;
  /**
   * The Step ran before and the Workflow looped back past it: it will run again. Its position
   * says "not started", which was what the board drew — over its earlier pass's cards.
   */
  ranBefore: boolean;
  items: BoardItem[];
}

/**
 * The run's Step history: every Step that finished (`session.stepDecisions`), and the order of
 * the Sessions they were recorded in — `seq` restarts per Session, so a position in the log is a
 * Session's rank and then a `seq`.
 */
export interface StepHistory {
  decisions: readonly TaskStepDecisionDto[];
  /** Session id → its rank, oldest first. */
  sessionOrder: ReadonlyMap<string, number>;
}

/** A decision that ended a pass of its Step: the cursor left it, or the Workflow finished. */
const endsPass = (d: TaskStepDecisionDto) => d.status === "advanced" || d.status === "completed";

function before(
  history: StepHistory,
  a: { sessionId: string; seq: number },
  b: { sessionId: string; seq: number },
): boolean {
  const ra = history.sessionOrder.get(a.sessionId) ?? Number.MAX_SAFE_INTEGER;
  const rb = history.sessionOrder.get(b.sessionId) ?? Number.MAX_SAFE_INTEGER;
  return ra < rb || (ra === rb && a.seq < b.seq);
}

/** Which pass of `stepId` an event at this position belongs to: one more than the passes it follows. */
export function passOf(
  history: StepHistory,
  stepId: string,
  at: { sessionId: string; seq: number },
): number {
  return (
    1 +
    history.decisions.filter((d) => d.stepId === stepId && endsPass(d) && before(history, d, at))
      .length
  );
}

/** The one column a Task on no Workflow has: its run. */
export const RUN_COLUMN_ID = "run";

/** Whether an item is waiting on a person right now — the amber, actionable kind. */
export function needsYou(item: BoardItem, state: TaskState): boolean {
  switch (item.kind) {
    case "permission":
      return item.row.resolution === null;
    case "asks":
      return state === "running" && item.rows.some((row) => row.response === null);
    case "gate":
      // Running, the gate is only on the board once the harness has finished: Open review.
      return state === "review" || state === "failed" || state === "parked" || state === "running";
    default:
      return false;
  }
}

/**
 * What the harness published, per Step: the latest plan, the latest todo list, every decision
 * (latest per id). Keyed by Step id, with `null` for whatever carries no Step.
 *
 * Both sources, with the live rule the workspace already uses for its own copies: the socket's
 * frames are never older than the query's, so the live copy wins — but only from the Session on
 * screen, because `seq` restarts per Session and a replay of an earlier round would otherwise win
 * on position alone.
 */
export interface StepFacts {
  plan: Map<string | null, StepCardWidget>;
  todos: Map<string | null, readonly TodoItem[]>;
  decisions: Map<string | null, Map<string, DecisionWidget>>;
  /** Where in the log each standing fact was last published: `plan:<step>`, `todos:<step>`, `decision:<id>`. */
  origin: Map<string, { sessionId: string; seq: number }>;
}

export function stepFacts(
  persisted: readonly SessionEventDto[],
  live: readonly TaskEvent[],
  liveSessionId: string | undefined,
): StepFacts {
  const facts: StepFacts = {
    plan: new Map(),
    todos: new Map(),
    decisions: new Map(),
    origin: new Map(),
  };
  const decide = (step: string | null, widget: DecisionWidget) => {
    const byId = facts.decisions.get(step) ?? new Map<string, DecisionWidget>();
    // Deleted first so a re-emission moves to the end: arrival order is the board's order.
    byId.delete(widget.id);
    byId.set(widget.id, widget);
    facts.decisions.set(step, byId);
  };
  const at = (key: string, sessionId: string, seq: number) =>
    facts.origin.set(key, { sessionId, seq });
  for (const event of persisted) {
    const step = event.workflowStepId ?? null;
    const p = event.payload;
    if (p.kind === "todos") {
      facts.todos.set(step, p.items);
      at(`todos:${step ?? ""}`, event.sessionId, event.seq);
    } else if (p.kind === "widget" && p.widget.kind === "step_card") {
      facts.plan.set(step, p.widget);
      at(`plan:${step ?? ""}`, event.sessionId, event.seq);
    } else if (p.kind === "widget" && p.widget.kind === "decision") {
      decide(step, p.widget);
      at(`decision:${p.widget.id}`, event.sessionId, event.seq);
    }
  }
  for (const event of live) {
    if (!("sessionId" in event) || event.sessionId !== liveSessionId) continue;
    const step = ("workflowStepId" in event ? event.workflowStepId : null) ?? null;
    const seq = "seq" in event ? event.seq : 0;
    if (event.kind === "todos") {
      facts.todos.set(step, event.items);
      at(`todos:${step ?? ""}`, event.sessionId, seq);
    } else if (event.kind === "widget" && event.widget.kind === "step_card") {
      facts.plan.set(step, event.widget);
      at(`plan:${step ?? ""}`, event.sessionId, seq);
    } else if (event.kind === "widget" && event.widget.kind === "decision") {
      decide(step, event.widget);
      at(`decision:${event.widget.id}`, event.sessionId, seq);
    }
  }
  return facts;
}

/**
 * The board's columns.
 *
 * **Where an unattributed item goes.** A frame with no Step — a Task on no Workflow, an
 * orchestrator older than the column — is filed under `home`: the Step the page is reading, which
 * is the one the run is on unless the operator picked another. That is the honest guess: the
 * persisted half of what the page holds was fetched for exactly that Step.
 *
 * **Order inside a column.** Plan, then todos, because those are the Step's standing state and
 * read top-down as "what it means to do, how far it is"; then decisions and questions in the
 * order they arrived, which is what makes a new one land at the bottom where the eye already is;
 * then the gate, which is always last because it is what the rest leads to.
 */
export function boardColumns({
  stepped,
  state,
  home,
  facts,
  rows,
  showGate,
  history = null,
}: {
  stepped: readonly SteppedStep[];
  state: TaskState;
  /** Where unattributed items go: the selected Step, else the current one. */
  home: string | null;
  facts: StepFacts;
  rows: readonly TranscriptRow[];
  /** Whether the Task has something for a person to do at its gate (see `TaskFooter`). */
  showGate: boolean;
  /** Which Steps finished, and when — how a loop is told from a Step that has not run. */
  history?: StepHistory | null;
}): BoardColumn[] {
  const columns: BoardColumn[] =
    stepped.length > 0
      ? stepped.map((s) => {
          const finished = (history?.decisions ?? []).filter(
            (d) => d.stepId === s.step.id && endsPass(d),
          ).length;
          const running = s.current && state !== "done";
          return {
            id: s.step.id,
            name: s.step.name,
            status: s.status,
            current: s.current,
            passes: finished + (running ? 1 : 0),
            ranBefore: !s.current && finished > 0 && s.status === "upcoming",
            items: [],
          };
        })
      : [
          {
            id: RUN_COLUMN_ID,
            name: "Run",
            status: runStatus(state),
            current: true,
            passes: 0,
            ranBefore: false,
            items: [],
          },
        ];
  const byId = new Map(columns.map((c) => [c.id, c]));
  const fallback =
    (home !== null ? byId.get(home) : undefined) ?? columns.find((c) => c.current) ?? columns[0];
  const columnFor = (step: string | null | undefined): BoardColumn | undefined =>
    (step ? byId.get(step) : undefined) ?? fallback;

  for (const [step, widget] of facts.plan) {
    columnFor(step)?.items.push({ kind: "plan", key: `plan:${step ?? ""}`, widget });
  }
  for (const [step, items] of facts.todos) {
    if (items.length === 0) continue;
    columnFor(step)?.items.push({ kind: "todos", key: `todos:${step ?? ""}`, items });
  }
  // Two unattributed sources can land in one column; the latest of each kind is what stands.
  for (const column of columns) dedupeStanding(column);

  // Decisions take their place in the arrival order the rows give, so they interleave with the
  // questions around them rather than all sitting above them.
  const decisionAt = new Map<string, number>();
  // Keyed on the decision's own id — what `facts` is keyed on — not the transport's widget id.
  rows.forEach((row, index) => {
    if (row.kind === "widget" && row.widget.kind === "decision")
      decisionAt.set(row.widget.id, index);
  });
  type Entry =
    | { kind: "decision"; widget: DecisionWidget }
    | { kind: "permission"; row: PermissionRow }
    | { kind: "ask"; row: WidgetRow };
  const timeline: Array<{ at: number; column: BoardColumn | undefined; entry: Entry }> = [];
  for (const [step, byWidget] of facts.decisions) {
    for (const widget of byWidget.values()) {
      timeline.push({
        at: decisionAt.get(widget.id) ?? Number.MAX_SAFE_INTEGER,
        column: columnFor(step),
        entry: { kind: "decision", widget },
      });
    }
  }
  rows.forEach((row, at) => {
    if (row.kind === "permission") {
      timeline.push({
        at,
        column: columnFor(row.workflowStepId),
        entry: { kind: "permission", row },
      });
    } else if (row.kind === "widget" && ASK_KINDS.has(row.widget.kind)) {
      timeline.push({ at, column: columnFor(row.workflowStepId), entry: { kind: "ask", row } });
    }
  });
  timeline.sort((a, b) => a.at - b.at);
  /*
   * Decisions and questions are stacked, one node per kind per Step, standing where the first of
   * them arrived. Six decisions drawn as six cards made the Step a wall of the one kind of thing
   * a reviewer settles in one sitting anyway; as a stack they are one place to go, and the dialog
   * behind it walks them all. A permission stays its own node: each is a separate grant.
   */
  const decisionGroups = new Map<BoardColumn, Extract<BoardItem, { kind: "decisions" }>>();
  const askGroups = new Map<BoardColumn, Extract<BoardItem, { kind: "asks" }>>();
  for (const { column, entry } of timeline) {
    if (!column) continue;
    if (entry.kind === "permission") {
      const { row } = entry;
      column.items.push({
        kind: "permission",
        key: `permission:${row.sessionId}:${row.requestId}`,
        row,
      });
    } else if (entry.kind === "decision") {
      const group = decisionGroups.get(column);
      if (group) group.widgets.push(entry.widget);
      else {
        const created = {
          kind: "decisions" as const,
          key: `decisions:${column.id}`,
          widgets: [entry.widget],
        };
        decisionGroups.set(column, created);
        column.items.push(created);
      }
    } else {
      const group = askGroups.get(column);
      if (group) group.rows.push(entry.row);
      else {
        const created = { kind: "asks" as const, key: `asks:${column.id}`, rows: [entry.row] };
        askGroups.set(column, created);
        column.items.push(created);
      }
    }
  }

  if (showGate) {
    const at = columns.find((c) => c.current) ?? fallback;
    at?.items.push({ kind: "gate", key: "gate" });
  }

  /*
   * Passes, said only once the Workflow has looped: a run that went straight through has one pass
   * of everything and a "pass 1" on every card would be noise. Once it has looped, every card
   * says which pass of its Step it came from, so a Review card from before the loop is never
   * read as Review running ahead of the Implement gate that is open now.
   */
  if (history && columns.some((c) => c.passes > 1 || c.ranBefore)) {
    const where = (item: BoardItem): { sessionId: string; seq: number } | undefined => {
      switch (item.kind) {
        case "plan":
        case "todos":
          return facts.origin.get(item.key);
        case "decisions":
          return item.widgets
            .map((w) => facts.origin.get(`decision:${w.id}`))
            .filter((o): o is { sessionId: string; seq: number } => o !== undefined)
            .at(-1);
        case "permission":
          return { sessionId: item.row.sessionId, seq: item.row.seq };
        case "asks": {
          const last = item.rows.at(-1);
          return last ? { sessionId: last.sessionId, seq: last.seq } : undefined;
        }
        default:
          return undefined;
      }
    };
    for (const column of columns) {
      if (column.id === RUN_COLUMN_ID) continue;
      for (const item of column.items) {
        if (item.kind === "gate") {
          item.pass = Math.max(1, column.passes);
          continue;
        }
        const origin = where(item);
        if (origin) item.pass = passOf(history, column.id, origin);
      }
    }
  }
  return columns;
}

/** Keep only the last plan and the last todo list a column was given, in that order, first. */
function dedupeStanding(column: BoardColumn): void {
  let plan: BoardItem | undefined;
  let todos: BoardItem | undefined;
  const rest: BoardItem[] = [];
  for (const item of column.items) {
    if (item.kind === "plan") plan = item;
    else if (item.kind === "todos") todos = item;
    else rest.push(item);
  }
  column.items = [...(plan ? [plan] : []), ...(todos ? [todos] : []), ...rest];
}

function runStatus(state: TaskState): StepStatus {
  switch (state) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "review":
    case "parked":
      return "waiting";
    default:
      return "upcoming";
  }
}

/** How many items on the board are waiting on a person. */
export function needsYouCount(columns: readonly BoardColumn[], state: TaskState): number {
  return columns.reduce((n, c) => n + c.items.filter((i) => needsYou(i, state)).length, 0);
}

/** The board's legend counts, for the left pane. */
export function boardTally(columns: readonly BoardColumn[]): {
  plans: number;
  todos: { done: number; of: number };
  decisions: number;
} {
  let plans = 0;
  let decisions = 0;
  const todos = { done: 0, of: 0 };
  for (const column of columns) {
    for (const item of column.items) {
      if (item.kind === "plan") plans += 1;
      else if (item.kind === "decisions") decisions += item.widgets.length;
      else if (item.kind === "todos") {
        todos.of += item.items.length;
        todos.done += item.items.filter((t) => t.status === "completed").length;
      }
    }
  }
  return { plans, todos, decisions };
}
