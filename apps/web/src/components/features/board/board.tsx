"use client";

import type { TaskDto } from "@gatecontrol/contracts";
import { ArrowRight, Play } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BOARD_COLUMNS, STATE_LABELS } from "@/lib/task-states";
import { trpc } from "@/trpc/react";
import { Column } from "./column";

/** Pure presentational board — groups Tasks into lifecycle columns (data-source agnostic). */
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
 * Kanban board (TASK-021). Fetches live Task data via tRPC and renders lifecycle columns with
 * per-card actions (advance Backlog→Ready, Launch a Ready Task). dnd-kit drag + live WebSocket
 * status updates are the follow-up increment.
 */
export function Board() {
  const utils = trpc.useUtils();
  const tasksQuery = trpc.task.list.useQuery({});
  const move = trpc.task.move.useMutation({ onSuccess: () => utils.task.list.invalidate() });
  const launch = trpc.task.launch.useMutation({ onSuccess: () => utils.task.list.invalidate() });

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

  return (
    <>
      {actionError ? (
        <p className="px-6 text-destructive text-sm" role="alert">
          {actionError.message}
        </p>
      ) : null}
      <BoardView tasks={tasksQuery.data ?? []} renderActions={renderActions} />
    </>
  );
}
