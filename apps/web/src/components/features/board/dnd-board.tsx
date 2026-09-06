"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { TaskDependencyDto, TaskDto, TaskState } from "@solow/contracts";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { type BoardColumn, columnIdFor, lifecycleColumns } from "@/lib/board-columns";
import { cn } from "@/lib/utils";
import { CARD_ENTRANCE_CLASS, ColumnEmpty, ColumnHeader } from "./column";
import { TaskCard } from "./task-card";

/**
 * A draggable card. The drag listeners live on a dedicated handle rather than the card body:
 * the body holds a link and action buttons, and nesting those inside a `role="button"` wrapper
 * would be invalid ARIA and unreachable by keyboard.
 */
function DraggableCard({
  task,
  actions,
  blockers,
  onSubmitForReview,
  submitting,
  draggable,
  workflowName,
  showState,
}: {
  task: TaskDto;
  actions?: ReactNode;
  blockers?: readonly TaskDependencyDto[] | undefined;
  onSubmitForReview?: ((taskId: string) => void) | undefined;
  submitting?: boolean | undefined;
  /** The Workflow this card is actually on, when the column it sits in does not say. */
  workflowName?: string | null | undefined;
  /** True in any column that is not a lifecycle state, where nothing else says what the run is doing. */
  showState: boolean;
  /**
   * False in a column nothing can be dropped into. The grip is the affordance that says "this
   * moves"; offering it where every drop would be refused teaches the gesture and then punishes
   * it, which is worse than not offering it.
   */
  draggable: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { state: task.state },
  });
  const handle = (
    <button
      type="button"
      aria-label={`Move ${task.title}`}
      className={cn(
        "-mr-1 -mt-0.5 shrink-0 cursor-grab touch-none rounded p-1 text-muted-foreground/0 transition-colors active:cursor-grabbing",
        // Revealed on hover or focus: a grip on every card at rest is visual clutter, but it
        // must still be reachable by keyboard, so focus brings it back too.
        "group-hover/card:text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:text-muted-foreground",
      )}
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-3.5" />
    </button>
  );
  return (
    <div ref={setNodeRef} className={cn(isDragging && "opacity-30")}>
      <TaskCard
        task={task}
        actions={actions}
        {...(draggable ? { dragHandle: handle } : {})}
        blockers={blockers}
        {...(onSubmitForReview ? { onSubmitForReview } : {})}
        submitting={submitting ?? false}
        workflowName={workflowName ?? null}
        showState={showState}
      />
    </div>
  );
}

/**
 * A column that accepts a drop. Only ever rendered for a `droppable` descriptor — a Step column
 * gets `PlainColumn` below, so dnd-kit is never even told the Step's id exists and cannot report
 * a drop over it.
 */
function DroppableColumn({
  column,
  tasks,
  renderActions,
  blockersFor,
  onSubmitForReview,
  submittingOn,
  workflowNameFor,
}: {
  column: BoardColumn;
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
  onSubmitForReview?: ((taskId: string) => void) | undefined;
  submittingOn?: ((taskId: string) => boolean) | undefined;
  workflowNameFor?: ((task: TaskDto) => string | null) | undefined;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <ColumnShell
      column={column}
      tasks={tasks}
      sectionRef={setNodeRef}
      isOver={isOver}
      draggable
      renderActions={renderActions}
      blockersFor={blockersFor}
      onSubmitForReview={onSubmitForReview}
      submittingOn={submittingOn}
      workflowNameFor={workflowNameFor}
    />
  );
}

/** A column that is not a drop target: it registers no droppable and its cards carry no grip. */
function PlainColumn(props: {
  column: BoardColumn;
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
  onSubmitForReview?: ((taskId: string) => void) | undefined;
  submittingOn?: ((taskId: string) => boolean) | undefined;
  workflowNameFor?: ((task: TaskDto) => string | null) | undefined;
}) {
  return <ColumnShell {...props} draggable={false} isOver={false} />;
}

/** The markup both share, so a droppable and a plain column cannot drift apart visually. */
function ColumnShell({
  column,
  tasks,
  sectionRef,
  isOver,
  draggable,
  renderActions,
  blockersFor,
  onSubmitForReview,
  submittingOn,
  workflowNameFor,
}: {
  column: BoardColumn;
  tasks: TaskDto[];
  sectionRef?: ((node: HTMLElement | null) => void) | undefined;
  isOver: boolean;
  draggable: boolean;
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
  onSubmitForReview?: ((taskId: string) => void) | undefined;
  submittingOn?: ((taskId: string) => boolean) | undefined;
  workflowNameFor?: ((task: TaskDto) => string | null) | undefined;
}) {
  return (
    <section
      ref={sectionRef}
      aria-label={`${column.label} column`}
      data-column={column.id}
      {...(column.kind === "state" ? { "data-state": column.state } : {})}
      className={cn(
        "relative flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-sidebar/60 transition-colors duration-150",
        isOver && "border-ring/60 bg-accent/30",
      )}
    >
      <ColumnHeader column={column} count={tasks.length} />
      {tasks.length === 0 ? (
        <ColumnEmpty label={column.label} />
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {tasks.map((task) => (
            <li key={task.id} className={CARD_ENTRANCE_CLASS}>
              <DraggableCard
                task={task}
                actions={renderActions?.(task)}
                blockers={blockersFor?.(task.id)}
                onSubmitForReview={onSubmitForReview}
                submitting={submittingOn?.(task.id) ?? false}
                draggable={draggable}
                workflowName={workflowNameFor?.(task) ?? null}
                showState={column.kind !== "state"}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What a drop on `overId` means, given the columns on screen.
 *
 * Exported and pure because it is the one decision in this file that must be provable. dnd-kit's
 * own drag cannot be driven in a DOM-less test — every element measures 0×0, so no droppable ever
 * wins a collision — and a rule this close to Principle I cannot be left to a test that would
 * pass whatever it did.
 */
export type DropResolution =
  | { kind: "move"; to: TaskState }
  /** A column no lifecycle move can express: a Workflow Step, or the `Other work` lane. */
  | { kind: "refused"; column: BoardColumn }
  /** Dropped on nothing this board knows, or back where it started. */
  | { kind: "none" };

/**
 * What a screen reader is told while a card is being dragged.
 *
 * Pure and exported for the same reason `resolveDrop` is: @dnd-kit's drag cannot be driven in this
 * test environment — every element measures 0×0, so no droppable ever wins a collision — and the
 * live region is empty until a drag begins. A test that rendered the board and looked for these
 * words would pass whether or not they were ever wired up, which is precisely the kind of test
 * this feature has already produced once.
 *
 * Overriding @dnd-kit's defaults is not a nicety. Its announcements read `over.id` aloud, and the
 * column ids stopped being bare state names when they became a discriminated union: the lifecycle
 * board went from saying "ready" to saying "state:ready", and a Step column would read out an
 * opaque id. That is a regression on the board every Workspace without a Workflow already has.
 * Labels are the words on the screen, so what is heard and what is seen agree.
 */
export function boardAnnouncements(
  columns: readonly BoardColumn[],
  tasks: readonly TaskDto[],
): {
  onDragStart(event: { active: { id: string | number } }): string;
  onDragOver(event: {
    active: { id: string | number };
    over: { id: string | number } | null;
  }): string;
  onDragEnd(event: {
    active: { id: string | number };
    over: { id: string | number } | null;
  }): string;
  onDragCancel(event: { active: { id: string | number } }): string;
} {
  const label = (id: string | number): string =>
    columns.find((column) => column.id === String(id))?.label ?? String(id);
  // "the task" rather than the id: a card that has scrolled out of the list is still not a thing
  // to read a uuid about.
  const title = (id: string | number): string =>
    tasks.find((task) => task.id === String(id))?.title ?? "the task";

  return {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${title(active.id)} is over ${label(over.id)}.`
        : `${title(active.id)} is no longer over a column.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${title(active.id)} was dropped on ${label(over.id)}.`
        : `${title(active.id)} was dropped, and nothing moved.`,
    onDragCancel: ({ active }) => `Dragging ${title(active.id)} was cancelled.`,
  };
}

export function resolveDrop(
  overId: string,
  from: TaskState,
  columns: readonly BoardColumn[],
): DropResolution {
  /*
   * A lookup, not a cast. This used to read `String(overId) as TaskState`, which was correct only
   * for as long as every column *was* a lifecycle state: under a Workflow the drop target's id is
   * a Step id, and the cast would have handed it to `task.move` as a state — writing a pipeline
   * position through the lifecycle machine, past the Step's gate, spending no approval and
   * recording no decision. Column ids are namespaced so that mistake cannot be made by accident.
   */
  const target = columns.find((column) => column.id === overId);
  if (!target) return { kind: "none" };
  if (target.kind !== "state") return { kind: "refused", column: target };
  if (target.state === from) return { kind: "none" };
  return { kind: "move", to: target.state };
}

/**
 * Drag-and-drop board: cards are draggable, and columns that accept a drop are drop targets
 * (TASK-021, issue #5 AC-6).
 *
 * The columns are a prop rather than `BOARD_COLUMNS` read in here. In lifecycle mode the default
 * is exactly the seven columns that always shipped; in Workflow mode the caller hands it one
 * column per Step. Which cards land where is `columnIdFor`'s answer, so the board never decides
 * it twice.
 */
export function DndBoard({
  tasks,
  columns = lifecycleColumns(),
  renderActions,
  blockersFor,
  onMove,
  onRefusedMove,
  workflowNameFor,
  onSubmitForReview,
  submittingOn,
}: {
  tasks: TaskDto[];
  /** What the board shows, left to right. Defaults to the lifecycle board. */
  columns?: readonly BoardColumn[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  // Same lookup the plain board takes, so the two cannot drift on whether a card looks blocked.
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
  onMove: (taskId: string, from: TaskState, to: TaskState) => void;
  /**
   * A drop that landed somewhere no lifecycle move exists for — a Step column, or the `Other
   * work` lane. Reported rather than silently swallowed: a card that snaps back with no words is
   * indistinguishable from a bug.
   */
  onRefusedMove?: ((column: BoardColumn) => void) | undefined;
  /**
   * The Workflow name behind a `workflowId`, for the `Other work` lane only — those cards are the
   * ones whose column says nothing about which pipeline they are on. Resolved by the caller from
   * the `workflow.list` its picker already fetched, so no card costs a query.
   */
  workflowNameFor?: ((workflowId: string) => string | null) | undefined;
  /** The card's green control — absent on a board that cannot act. */
  onSubmitForReview?: ((taskId: string) => void) | undefined;
  submittingOn?: ((taskId: string) => boolean) | undefined;
  /** e.g. the Backlog column's "new issue" / "connect repository" buttons. */
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // A small activation distance keeps a click on the handle from starting a drag.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
    // Keyboard drag from the handle, so the board is operable without a pointer.
    useSensor(KeyboardSensor),
  );
  const activeTask = tasks.find((t) => t.id === activeId) ?? null;

  const handleEnd = (e: DragEndEvent) => {
    setActiveId(null);
    const overId = e.over?.id;
    if (!overId) return;
    const task = tasks.find((t) => t.id === e.active.id);
    if (!task) return;
    const resolution = resolveDrop(String(overId), task.state, columns);
    if (resolution.kind === "refused") onRefusedMove?.(resolution.column);
    if (resolution.kind === "move") onMove(task.id, task.state, resolution.to);
  };

  const announcements = boardAnnouncements(columns, tasks);

  return (
    <DndContext
      sensors={sensors}
      accessibility={{ announcements }}
      onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
      onDragEnd={handleEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <section
        className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-4"
        aria-label="Task board"
      >
        {columns.map((column) => {
          // `Other work` is the one column that earns its place only when it has something in
          // it: an always-present empty lane would imply the Workspace has stray work when it
          // has none.
          const held = tasks.filter((task) => columnIdFor(task, columns) === column.id);
          if (column.kind === "other" && held.length === 0) return null;
          // Only in the `Other work` lane: everywhere else the column itself already says which
          // pipeline the card is on, and repeating it on every tile would be noise.
          const nameOnCard =
            column.kind === "other" && workflowNameFor
              ? (task: TaskDto) => (task.workflowId ? workflowNameFor(task.workflowId) : null)
              : undefined;
          const shared = {
            column,
            tasks: held,
            renderActions,
            blockersFor,
            onSubmitForReview,
            submittingOn,
            workflowNameFor: nameOnCard,
          };
          return column.droppable ? (
            <DroppableColumn key={column.id} {...shared} />
          ) : (
            <PlainColumn key={column.id} {...shared} />
          );
        })}
      </section>
      {/* Lifted and tilted while in hand, so the card reads as picked up rather than duplicated. */}
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.16,1,0.3,1)" }}>
        {activeTask ? (
          <div className="w-[268px] rotate-2 shadow-float">
            {/* The same blockers the column copy has, so a blocked card does not un-dim and lose
                its lock for the length of the drag — and `ghost`, so the two copies do not both
                claim the same DOM id. */}
            <TaskCard task={activeTask} blockers={blockersFor?.(activeTask.id)} ghost />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
