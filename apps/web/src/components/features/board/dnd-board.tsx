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
import type { TaskDependencyDto, TaskDto, TaskState } from "@gatecontrol/contracts";
import { GripVertical } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { BOARD_COLUMNS, STATE_LABELS } from "@/lib/task-states";
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
}: {
  task: TaskDto;
  actions?: ReactNode;
  blockers?: readonly TaskDependencyDto[] | undefined;
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
      <TaskCard task={task} actions={actions} dragHandle={handle} blockers={blockers} />
    </div>
  );
}

function DroppableColumn({
  state,
  label,
  tasks,
  renderActions,
  blockersFor,
}: {
  state: TaskState;
  label: string;
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: state });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${label} column`}
      data-state={state}
      className={cn(
        "relative flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-sidebar/60 transition-colors duration-150",
        isOver && "border-ring/60 bg-accent/30",
      )}
    >
      <ColumnHeader state={state} label={label} count={tasks.length} />
      {tasks.length === 0 ? (
        <ColumnEmpty label={label} />
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {tasks.map((task) => (
            <li key={task.id} className={CARD_ENTRANCE_CLASS}>
              <DraggableCard
                task={task}
                actions={renderActions?.(task)}
                blockers={blockersFor?.(task.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Drag-and-drop board: cards are draggable, columns are drop targets (TASK-021). */
export function DndBoard({
  tasks,
  renderActions,
  blockersFor,
  onMove,
}: {
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  // Same lookup the plain board takes, so the two cannot drift on whether a card looks blocked.
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
  onMove: (taskId: string, from: TaskState, to: TaskState) => void;
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
    const to = String(overId) as TaskState;
    if (to !== task.state) onMove(task.id, task.state, to);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))}
      onDragEnd={handleEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <section
        className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-4"
        aria-label="Task board"
      >
        {BOARD_COLUMNS.map((state) => (
          <DroppableColumn
            key={state}
            state={state}
            label={STATE_LABELS[state]}
            tasks={tasks.filter((task) => task.state === state)}
            renderActions={renderActions}
            blockersFor={blockersFor}
          />
        ))}
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
