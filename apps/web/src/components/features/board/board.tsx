"use client";

import type { TaskDto, TaskState } from "@gatecontrol/contracts";
import { canTransitionTask } from "@gatecontrol/core";
import { ArrowRight, Play } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { BOARD_COLUMNS, STATE_LABELS } from "@/lib/task-states";
import { trpc } from "@/trpc/react";
import { Column } from "./column";
import { DndBoard } from "./dnd-board";

/** Pure presentational board — groups Tasks into lifecycle columns (used by tests). */
export function BoardView({
  tasks,
  renderActions,
}: {
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
}) {
  return (
    <section className="flex gap-3 overflow-x-auto p-4" aria-label="Task board">
      {BOARD_COLUMNS.map((state) => (
        <Column
          key={state}
          state={state}
          label={STATE_LABELS[state]}
          tasks={tasks.filter((task) => task.state === state)}
          renderActions={renderActions}
        />
      ))}
    </section>
  );
}

/**
 * Kanban board (TASK-021). Live Task data via tRPC, drag-and-drop between lifecycle columns
 * (illegal transitions are rejected with a reason via the shared state machine), and per-card
 * actions (advance Backlog→Ready, Launch a Ready Task).
 */
export function Board() {
  const utils = trpc.useUtils();
  const tasksQuery = trpc.task.list.useQuery({});
  const move = trpc.task.move.useMutation({ onSuccess: () => utils.task.list.invalidate() });
  const launch = trpc.task.launch.useMutation({ onSuccess: () => utils.task.list.invalidate() });
  const [dragError, setDragError] = useState<string | null>(null);

  if (tasksQuery.isLoading) {
    return <p className="p-6 text-muted-foreground text-sm">Loading board…</p>;
  }
  if (tasksQuery.error) {
    return (
      <p className="p-6 text-destructive text-sm" role="alert">
        Failed to load the board: {tasksQuery.error.message}
      </p>
    );
  }

  const busy = move.isPending || launch.isPending;
  const actionError = move.error ?? launch.error;

  const onMove = (taskId: string, from: TaskState, to: TaskState) => {
    const res = canTransitionTask(from, to);
    if (!res.ok) {
      setDragError(`Can't move ${STATE_LABELS[from]} → ${STATE_LABELS[to]}`);
      return;
    }
    setDragError(null);
    move.mutate({ id: taskId, to });
  };

  const renderActions = (task: TaskDto): ReactNode => {
    if (task.state === "backlog") {
      return (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => move.mutate({ id: task.id, to: "ready" })}
        >
          Ready <ArrowRight />
        </Button>
      );
    }
    if (task.state === "ready") {
      return (
        <Button size="sm" disabled={busy} onClick={() => launch.mutate({ id: task.id })}>
          <Play /> Launch
        </Button>
      );
    }
    return null;
  };

  const errorMessage = dragError ?? actionError?.message ?? null;

  return (
    <>
      {errorMessage ? (
        <p className="px-6 pt-2 text-destructive text-sm" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <DndBoard tasks={tasksQuery.data ?? []} renderActions={renderActions} onMove={onMove} />
    </>
  );
}
