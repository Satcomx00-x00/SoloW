"use client";

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { TaskDto, TaskState } from "@gatecontrol/contracts";
import type { ReactNode } from "react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { BOARD_COLUMNS, STATE_BADGE, STATE_LABELS } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { TaskCard } from "./task-card";

function DraggableCard({ task, actions }: { task: TaskDto; actions?: ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { state: task.state },
  });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn("cursor-grab touch-none active:cursor-grabbing", isDragging && "opacity-40")}
    >
      <TaskCard task={task} actions={actions} />
    </div>
  );
}

function DroppableColumn({
  state,
  label,
  tasks,
  renderActions,
}: {
  state: TaskState;
  label: string;
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: state });
  return (
    <section
      ref={setNodeRef}
      aria-label={`${label} column`}
      data-state={state}
      className={cn(
        "flex w-64 shrink-0 flex-col rounded-lg border bg-muted/40 transition-colors",
        isOver && "border-ring bg-accent/40",
      )}
    >
      <header className="flex items-center justify-between px-3 py-2.5">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {label}
        </span>
        <Badge variant={STATE_BADGE[state]}>{tasks.length}</Badge>
      </header>
      {tasks.length === 0 ? (
        <p className="px-3 pb-3 text-muted-foreground text-xs">No tasks</p>
      ) : (
        <ul className="flex flex-col gap-2 px-2 pb-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <DraggableCard task={task} actions={renderActions?.(task)} />
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
  onMove,
}: {
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  onMove: (taskId: string, from: TaskState, to: TaskState) => void;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // A small activation distance lets clicks (title link, action buttons) pass through.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 6 } }),
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
      <section className="flex gap-3 overflow-x-auto p-4" aria-label="Task board">
        {BOARD_COLUMNS.map((state) => (
          <DroppableColumn
            key={state}
            state={state}
            label={STATE_LABELS[state]}
            tasks={tasks.filter((task) => task.state === state)}
            renderActions={renderActions}
          />
        ))}
      </section>
      <DragOverlay>
        {activeTask ? (
          <div className="w-60">
            <TaskCard task={activeTask} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
