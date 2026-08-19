"use client";

import { CommonErrorCode, type TaskDto, type TaskState } from "@gatecontrol/contracts";
import { canTransitionTask } from "@gatecontrol/core";
import { ArrowRight, Play, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { useEventStream } from "@/components/hooks/use-task-stream";
import { HeaderActions } from "@/components/shell/header-actions";
import { Button } from "@/components/ui/button";
import { BOARD_COLUMNS, STATE_LABELS } from "@/lib/task-states";
import { trpc } from "@/trpc/react";
import { Column } from "./column";
import { CreateIssueDialog } from "./create-issue-dialog";
import { CreateTaskDialog } from "./create-task-dialog";
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
    <section
      className="flex min-h-0 flex-1 items-stretch gap-3 overflow-x-auto p-4"
      aria-label="Task board"
    >
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
 * Loading placeholder shaped like the board it is standing in for, so the layout does not jump
 * when the data lands. A spinner in the middle of the page would tell the reader less and move
 * more (constitution: skeletal loaders matching the final layout).
 */
function BoardSkeleton() {
  // An uneven, plausible distribution rather than equal columns: the placeholder should look
  // like a board mid-use, not like a grid.
  const shape: Array<{ state: string; cards: number[] }> = BOARD_COLUMNS.slice(0, 5)
    .map((state, index) => ({
      state,
      cards: [3, 2, 1, 2, 1][index] ?? 1,
    }))
    .map(({ state, cards }) => ({
      state,
      cards: Array.from({ length: cards }, (_, card) => card),
    }));

  return (
    <div className="flex items-start gap-3 p-4" aria-hidden>
      {shape.map(({ state, cards }, index) => (
        <div
          key={state}
          className="flex w-72 shrink-0 flex-col gap-2 rounded-xl border bg-sidebar/40 p-2 pt-3"
        >
          <div className="mb-1 h-3 w-24 animate-pulse rounded-full bg-muted" />
          {cards.map((card) => (
            <div
              key={`${state}-card-${card}`}
              className="h-[68px] animate-pulse rounded-lg border bg-card"
              style={{ animationDelay: `${(index * 2 + card) * 60}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Shown when the Workspace has no Tasks at all, rather than seven empty columns. */
function BoardEmpty() {
  return (
    <div className="flex flex-col items-start gap-2 px-6 py-16">
      <h2 className="font-medium text-sm">No tasks yet</h2>
      <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
        Create an issue to describe the work, then a task to hand a slice of it to an agent. It runs
        in its own worktree and comes back here for your review.
      </p>
    </div>
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
  const [pendingMove, setPendingMove] = useState<{ taskId: string; to: TaskState } | null>(null);

  // Live board (TASK-018/021): the orchestrator announces every Task state change on the
  // Workspace channel, so a run that advances in the background lands here without a poll.
  const onStatus = useCallback(() => {
    utils.task.list.invalidate();
  }, [utils]);
  useEventStream({ onEvent: onStatus });

  if (tasksQuery.isLoading) return <BoardSkeleton />;

  if (tasksQuery.error) {
    // A disabled flag is an operator state, not a fault — say what it is and how to change it,
    // rather than showing the raw error code to someone who cannot act on it.
    if (tasksQuery.error.message === CommonErrorCode.FlagDisabled) {
      return (
        <div className="flex flex-col items-start gap-3 px-6 py-16" role="alert">
          <h2 className="font-medium text-sm">The core program is not enabled here</h2>
          <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
            Feature flags ship off. Enable it from the machine running this instance:
          </p>
          <pre className="rounded-lg border bg-card px-3 py-2 font-mono text-xs">
            bun run flag enable ff-core-program
          </pre>
        </div>
      );
    }
    return (
      <div className="flex items-start gap-2.5 px-6 py-16 text-sm" role="alert">
        <TriangleAlert className="mt-px size-4 shrink-0 text-state-failed" aria-hidden />
        <div>
          <p className="font-medium">Failed to load the board</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {tasksQuery.error.message}
          </p>
        </div>
      </div>
    );
  }

  const tasks = tasksQuery.data ?? [];
  const busy = move.isPending || launch.isPending;
  const actionError = move.error ?? launch.error;
  // Spin only the card that was clicked. `busy` still blocks the rest, but a global spinner
  // would claim every task on the board is doing something when one of them is.
  const pendingOn = (id: string) =>
    (move.isPending && move.variables?.id === id) ||
    (launch.isPending && launch.variables?.id === id);

  const onMove = (taskId: string, from: TaskState, to: TaskState) => {
    const res = canTransitionTask(from, to);
    if (!res.ok) {
      setDragError(`Can't move ${STATE_LABELS[from]} → ${STATE_LABELS[to]}`);
      return;
    }
    setDragError(null);
    // Dragging a Task out of Review abandons the agent's proposed changes and leaves no review
    // decision behind, so it is confirmed like any other discard (TASK-022).
    if (from === "review") {
      setPendingMove({ taskId, to });
      return;
    }
    move.mutate({ id: taskId, to });
  };

  const renderActions = (task: TaskDto): ReactNode => {
    if (task.state === "backlog") {
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          loading={pendingOn(task.id)}
          onClick={() => move.mutate({ id: task.id, to: "ready" })}
        >
          Ready <ArrowRight />
        </Button>
      );
    }
    if (task.state === "ready") {
      return (
        <Button
          size="xs"
          disabled={busy}
          loading={pendingOn(task.id)}
          onClick={() => launch.mutate({ id: task.id })}
        >
          <Play /> Launch
        </Button>
      );
    }
    return null;
  };

  const errorMessage = dragError ?? actionError?.message ?? null;

  return (
    <>
      <HeaderActions>
        <CreateIssueDialog />
        <CreateTaskDialog />
      </HeaderActions>
      {errorMessage ? (
        <p
          className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-state-failed/30 bg-state-failed/10 px-3 py-2 text-state-failed text-sm"
          role="alert"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          {errorMessage}
        </p>
      ) : null}
      {tasks.length === 0 ? (
        <BoardEmpty />
      ) : (
        <DndBoard tasks={tasks} renderActions={renderActions} onMove={onMove} />
      )}
      <ConfirmDialog
        open={pendingMove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null);
        }}
        title="Move this task out of review?"
        description="The agent's proposed changes are left behind and no review decision is recorded. To reject the work properly, and keep the audit trail, open the task and use Reject."
        confirmLabel="Move it anyway"
        onConfirm={() => {
          if (pendingMove) move.mutate({ id: pendingMove.taskId, to: pendingMove.to });
          setPendingMove(null);
        }}
      />
    </>
  );
}
