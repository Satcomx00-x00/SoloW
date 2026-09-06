import type { TaskDto, TaskState, WorkflowStepDto, WorkflowStepGate } from "@solow/contracts";
import { sortSteps } from "@solow/core";
import { Inbox, type LucideIcon, ShieldCheck, UserRoundCheck, Zap } from "lucide-react";
import { BOARD_COLUMNS, STATE_LABELS, STATE_STYLE } from "./task-states";

/**
 * The board's columns, as data (issue #5 AC-6).
 *
 * AC-6 asks that the columns stop being *hardcoded to* the lifecycle enum — not that the enum
 * stop existing. `taskStateSchema` is load-bearing well outside the board (the reaper sweeps
 * `running`/`review`, reconciliation reasons about `parked`, `canTransitionTask` is the server's
 * own refusal, `task_ws_state` is indexed on it, and the E2E suite selects on `data-task-state`),
 * so it survives untouched and the *lifecycle* board is derived from `BOARD_COLUMNS` rather than
 * rewritten. `lifecycleColumns()` is therefore identical to the seven columns that shipped
 * yesterday by construction, which is the regression that matters most here.
 *
 * Nothing in this module is a component: it is the description a column renderer consumes, which
 * is what lets the same `Column`/`DroppableColumn` draw a lifecycle state and a Workflow Step
 * without either knowing about the other.
 *
 * Column ids are namespaced — `state:<state>`, `step:<id>`, `other`. That is not tidiness: the
 * drag surface used to read a drop target's id and cast it straight to a `TaskState`, and in
 * Workflow mode a bare Step id would have been handed to `task.move` as a lifecycle state. A
 * namespaced id cannot be mistaken for a state by anything, including a future reader.
 */

interface ColumnChrome {
  label: string;
  icon: LucideIcon;
  /** Just the foreground colour, for the header glyph. */
  textClassName: string;
  /** Just the fill, for the hairline rule across the column head. */
  barClassName: string;
  /** Longer-form meaning, shown as the header's title. */
  hint: string;
}

export type BoardColumn =
  | (ColumnChrome & {
      kind: "state";
      id: `state:${TaskState}`;
      state: TaskState;
      /** A lifecycle column accepts a drop: moving a card between states is what `task.move` is. */
      droppable: true;
    })
  | (ColumnChrome & {
      kind: "step";
      id: `step:${string}`;
      stepId: string;
      /**
       * The Workflow the Step belongs to. `columnIdFor` needs it to tell "this Task is on the
       * selected Workflow" from "this Task is on some other one", and taking it off the column
       * list keeps that function a pure `(task, columns)` lookup rather than something that has
       * to be told separately which Workflow the board is showing.
       */
      workflowId: string;
      /** 1-based place in pipeline order — derived from the rank here, never from `step.position`. */
      position: number;
      gate: WorkflowStepGate;
      /** Never a drop target — see `stepMoveRefusal` in the board's `blockers.ts` for why. */
      droppable: false;
    })
  | (ColumnChrome & {
      kind: "other";
      id: "other";
      droppable: false;
    });

/**
 * The lifecycle board, derived from `BOARD_COLUMNS` and `STATE_STYLE` rather than restated.
 *
 * A module-level constant, not a fresh array per call: it is the default column list for the
 * board, and a new array identity on every render would defeat the memoisation of everything
 * downstream of it.
 */
const LIFECYCLE_COLUMNS: readonly BoardColumn[] = BOARD_COLUMNS.map((state) => {
  const style = STATE_STYLE[state];
  return {
    kind: "state",
    id: `state:${state}`,
    state,
    label: STATE_LABELS[state],
    icon: style.icon,
    textClassName: style.textClassName,
    barClassName: style.barClassName,
    hint: style.hint,
    droppable: true,
  } as const;
});

export function lifecycleColumns(): readonly BoardColumn[] {
  return LIFECYCLE_COLUMNS;
}

/**
 * How a Step column is dressed, from its gate and nothing else.
 *
 * A `human` Step is the one a person has to clear, so it borrows the hue Review already owns —
 * the board's existing answer to "this is waiting on you". The two automatic gates are muted:
 * they are not waiting on anybody, and colouring them would spend the reader's attention on the
 * columns that need none.
 *
 * Never hashed from the Step id. A colour derived from an id means nothing, and the whole reason
 * `STATE_STYLE` pairs every hue with its own glyph is WCAG 1.4.1 — a distinction a colour-blind
 * reader cannot see is not a distinction.
 */
const GATE_CHROME: Record<WorkflowStepGate, Omit<ColumnChrome, "label">> = {
  human: {
    icon: UserRoundCheck,
    textClassName: STATE_STYLE.review.textClassName,
    barClassName: STATE_STYLE.review.barClassName,
    hint: "Advances when you approve the review",
  },
  auto: {
    icon: Zap,
    textClassName: "text-muted-foreground",
    barClassName: "bg-muted-foreground/40",
    hint: "Advances on its own — the work still needs your approval before anything is integrated",
  },
  "auto-unless-changes": {
    icon: ShieldCheck,
    textClassName: "text-muted-foreground",
    barClassName: "bg-muted-foreground/40",
    hint: "Advances on its own unless the run produced changes, which need your approval",
  },
};

/**
 * One column per Step in pipeline order, then Done, then the lane for everything else.
 *
 * `Done` is the one lifecycle state that earns a column here, because it is the one that means
 * the Task has *left* the pipeline. `running`, `review`, `parked` and `failed` stay on the card
 * as its badge: the column says where in the pipeline the work is, the badge says what is
 * happening to it. A failed Task therefore stays visible on the Step it died on, which is more
 * useful than teleporting it out of the pipeline it is still in.
 *
 * Ordering is `sortSteps` — i.e. the rank — and never `step.position`. `position` is derived
 * server-side on read, so a list assembled from two reads could carry stale ordinals; the rank
 * is the stored order and the only one that cannot disagree with itself.
 */
export function workflowColumns(steps: readonly WorkflowStepDto[]): readonly BoardColumn[] {
  const ordered = sortSteps(steps);
  const done = STATE_STYLE.done;
  return [
    ...ordered.map((step, index): BoardColumn => {
      const chrome = GATE_CHROME[step.gate];
      return {
        kind: "step",
        id: `step:${step.id}`,
        stepId: step.id,
        workflowId: step.workflowId,
        position: index + 1,
        gate: step.gate,
        // The place in the pipeline rides in the label because the column head has exactly one
        // glyph slot and the gate has the better claim on it: an operator scanning the board is
        // looking for where a human is needed, and the columns are already left-to-right.
        label: `${index + 1} · ${step.name}`,
        icon: chrome.icon,
        textClassName: chrome.textClassName,
        barClassName: chrome.barClassName,
        hint: chrome.hint,
        droppable: false,
      };
    }),
    {
      kind: "state",
      id: "state:done",
      state: "done",
      label: STATE_LABELS.done,
      icon: done.icon,
      textClassName: done.textClassName,
      barClassName: done.barClassName,
      hint: done.hint,
      droppable: true,
    },
    {
      kind: "other",
      id: "other",
      label: "Other work",
      icon: Inbox,
      textClassName: "text-muted-foreground",
      barClassName: "bg-border",
      hint: "Tasks on another workflow, or on none",
      droppable: false,
    },
  ];
}

/**
 * Which column a card belongs in, resolved against the column list actually on screen.
 *
 * In lifecycle mode that is just the Task's state. In Workflow mode the precedence is:
 *   1. not on the selected Workflow (including on none) → the `other` lane;
 *   2. `done` → the terminal Done column, even though its cursor still names a Step;
 *   3. otherwise → its Step column, and Step 1 when the cursor is still null.
 *
 * A null cursor landing on Step 1 is `resumeWorkflowCursor`'s own answer to a null cursor, and
 * the card keeps its `backlog`/`ready` badge, which already says it has not started — a separate
 * "Unstarted" lane would only duplicate the badge.
 *
 * A cursor naming a Step that is not in `columns` also lands on Step 1. That case is unreachable
 * through the product today — `workflow.deleteStep` refuses with `StepInUse` while any Task's
 * cursor is parked on the Step — so it is a fallback rather than a handled state; if it ever
 * becomes reachable, the card appears at the head of the pipeline rather than vanishing.
 *
 * Returns null when no column can hold the card, which the caller must treat as "do not render
 * this tile anywhere" rather than as "render it in the first column".
 */
export function columnIdFor(task: TaskDto, columns: readonly BoardColumn[]): string | null {
  const steps = columns.filter((column) => column.kind === "step");
  const first = steps[0];
  if (!first) {
    const id = `state:${task.state}` as const;
    return columns.some((column) => column.id === id) ? id : null;
  }
  const other = columns.find((column) => column.kind === "other");
  if (task.workflowId !== first.workflowId) return other?.id ?? null;
  if (task.state === "done") {
    return columns.find((column) => column.id === "state:done")?.id ?? other?.id ?? null;
  }
  const cursor = task.workflowStepId;
  const onList = cursor !== null && steps.some((column) => column.stepId === cursor);
  return `step:${onList ? cursor : first.stepId}`;
}
