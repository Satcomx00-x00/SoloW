"use client";

import { BOARD_COLUMNS, STATE_LABELS } from "@/lib/task-states";
import { trpc } from "@/trpc/react";
import { Column } from "./column";

/**
 * Kanban board (TASK-021, vertical slice). Renders the lifecycle columns from live Task data
 * via tRPC. dnd-kit drag + live WebSocket status updates are the follow-up increment.
 */
export function Board() {
  const tasksQuery = trpc.task.list.useQuery({});

  if (tasksQuery.isLoading) {
    return <p className="state">Loading board…</p>;
  }
  if (tasksQuery.error) {
    return (
      <p className="state" role="alert">
        Failed to load the board: {tasksQuery.error.message}
      </p>
    );
  }

  const tasks = tasksQuery.data ?? [];

  return (
    <section className="board" aria-label="Task board">
      {BOARD_COLUMNS.map((state) => (
        <Column
          key={state}
          state={state}
          label={STATE_LABELS[state]}
          tasks={tasks.filter((task) => task.state === state)}
        />
      ))}
    </section>
  );
}
