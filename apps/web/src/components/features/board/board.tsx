"use client";

import {
  CommonErrorCode,
  type TaskDependencyDto,
  type TaskDto,
  type TaskState,
} from "@gatecontrol/contracts";
import { unsatisfiedDependencies } from "@gatecontrol/core";
import { ArrowRight, KeyRound, Link2, Play, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { DeleteTaskAction } from "@/components/features/task/delete-task-action";
import { useEventStream } from "@/components/hooks/use-task-stream";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { taskActionMessage } from "@/lib/task-errors";
import { BOARD_COLUMNS, CREDENTIAL_EXPIRED_REASON, STATE_LABELS } from "@/lib/task-states";
import { trpc } from "@/trpc/react";
import { BlockedByDialog } from "./blocked-by-dialog";
import { moveRefusal, waitingOn } from "./blockers";
import { type BoardReferences, BoardReferencesProvider } from "./board-references";
import { Column } from "./column";
import { DependencyCycleDialog } from "./dependency-cycle-dialog";
import { DndBoard } from "./dnd-board";

/** Pure presentational board — groups Tasks into lifecycle columns (used by tests). */
export function BoardView({
  tasks,
  renderActions,
  blockersFor,
}: {
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
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
          blockersFor={blockersFor}
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
/**
 * The board, scoped to where it is mounted.
 *
 * `projectId` is how a board inside a Project shows that Project's runs and nothing else — a
 * project-scoped screen fed by an unscoped query would show the whole Workspace under a
 * project's name, which is the one thing a scoped screen must never do. `unassigned` is the
 * mirror image: the Tasks whose Issue no Project holds, which would otherwise be unreachable.
 *
 * Both absent is the Workspace-wide board, which nothing routes to any more but which the
 * component still expresses honestly rather than by pretending a filter was applied.
 */
export function Board({
  projectId,
  unassigned,
}: {
  projectId?: string | undefined;
  unassigned?: boolean | undefined;
} = {}) {
  const utils = trpc.useUtils();
  const tasksQuery = trpc.task.list.useQuery({
    ...(projectId ? { projectId } : {}),
    ...(unassigned ? { unassigned: true } : {}),
  });
  // The whole Workspace's edges in one query (issue #6): readiness is derived from the blockers'
  // states, so this is also what makes a card un-dim the moment its last predecessor is Done —
  // there is no per-Task "blocked" flag anywhere that could be left stale.
  const dependenciesQuery = trpc.task.dependencies.useQuery({});
  // Which Secret a credential-expired card's "Renew" action should point at (spec AC-013,
  // issue #63). Both queries are already fetched elsewhere in the app with this same empty
  // input (`create-task-dialog.tsx`, `secrets-section.tsx`), so React Query serves this from
  // its existing cache far more often than it issues a new request.
  const agentProfilesQuery = trpc.profile.agent.list.useQuery({});
  const secretsQuery = trpc.secret.list.useQuery({});
  /**
   * The names behind the ids a card carries: which Repository its branch is in, and which Issue
   * it came from (see `board-references.tsx`).
   *
   * Deliberately *not* joined into the readiness gate below. A card whose repository name has
   * not landed yet is still a perfectly readable card — it just says one thing less for a
   * moment — whereas holding the whole board behind two more requests would make every load
   * wait on data no decision depends on.
   */
  const repositoriesQuery = trpc.repository.list.useQuery({});
  const issuesQuery = trpc.issue.list.useQuery({});
  const references = useMemo<BoardReferences>(() => {
    const byRepository = new Map((repositoriesQuery.data ?? []).map((r) => [r.id, r.name]));
    const byIssue = new Map((issuesQuery.data ?? []).map((i) => [i.id, i]));
    return {
      repositoryName: (id) => byRepository.get(id) ?? null,
      issue: (id) => byIssue.get(id) ?? null,
    };
  }, [repositoriesQuery.data, issuesQuery.data]);
  const refresh = () => {
    void utils.task.list.invalidate();
    void utils.task.dependencies.invalidate();
  };
  const move = trpc.task.move.useMutation({ onSuccess: refresh });
  const launch = trpc.task.launch.useMutation({ onSuccess: refresh });
  const retry = trpc.task.retry.useMutation({ onSuccess: refresh });
  // The card's green control. A mutation of its own rather than `move`, because it asserts the
  // work is ready to judge and is refused when the agent has not said so — dragging a card and
  // opening the gate are two different acts.
  const submitForReview = trpc.task.submitForReview.useMutation({ onSuccess: refresh });
  const [dragError, setDragError] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<{ taskId: string; to: TaskState } | null>(null);
  const [editingBlockersFor, setEditingBlockersFor] = useState<TaskDto | null>(null);
  const [cyclePath, setCyclePath] = useState<readonly string[] | null>(null);

  // Live board (TASK-018/021): the orchestrator announces every Task state change on the
  // Workspace channel, so a run that advances in the background lands here without a poll.
  // Dependencies ride the same event — the announcement that moves a predecessor into Done is
  // exactly the announcement that unblocks whatever was waiting on it (AC-4).
  const onStatus = useCallback(() => {
    utils.task.list.invalidate();
    utils.task.dependencies.invalidate();
  }, [utils]);
  useEventStream({ onEvent: onStatus });

  // Both queries, not just the Tasks: readiness is derived from the edges, so a board drawn
  // before they land would render every blocked card undimmed, lockless and launchable. The
  // absence of edge data is not evidence that nothing is blocked — wait for it, and if it never
  // arrives say so rather than showing a Workspace that looks unblocked forever (AC-4).
  // Error before loading, not after: with two queries in flight one can fail while the other is
  // still running, and a skeleton that hides a failure until its sibling settles tells the
  // reader "still working" about something that has already stopped.
  const loadError = tasksQuery.error ?? dependenciesQuery.error;
  if (!loadError && (tasksQuery.isLoading || dependenciesQuery.isLoading)) return <BoardSkeleton />;

  if (loadError) {
    // A disabled flag is an operator state, not a fault — say what it is and how to change it,
    // rather than showing the raw error code to someone who cannot act on it.
    if (loadError.message === CommonErrorCode.FlagDisabled) {
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
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{loadError.message}</p>
        </div>
      </div>
    );
  }

  const tasks = tasksQuery.data ?? [];
  const edges = dependenciesQuery.data ?? [];
  const blockersByTask = new Map<string, TaskDependencyDto[]>();
  for (const edge of edges) {
    const existing = blockersByTask.get(edge.taskId);
    if (existing) existing.push(edge);
    else blockersByTask.set(edge.taskId, [edge]);
  }
  const blockersFor = (taskId: string) => blockersByTask.get(taskId);
  const outstandingFor = (taskId: string) => unsatisfiedDependencies(blockersFor(taskId) ?? []);

  // Agent Profile → the name of the Secret it spends, so the Renew link can say which
  // credential it is about to open rather than sending the Owner to a bare form.
  const secretNameById = new Map((secretsQuery.data ?? []).map((s) => [s.id, s.name]));
  const credentialNameByProfile = new Map(
    (agentProfilesQuery.data ?? []).map((p) => [p.id, secretNameById.get(p.secretId) ?? null]),
  );

  const busy = move.isPending || launch.isPending || retry.isPending;
  const actionError = move.error ?? launch.error ?? retry.error ?? submitForReview.error;
  // Spin only the card that was clicked. `busy` still blocks the rest, but a global spinner
  // would claim every task on the board is doing something when one of them is.
  const pendingOn = (id: string) =>
    (move.isPending && move.variables?.id === id) ||
    (launch.isPending && launch.variables?.id === id) ||
    (retry.isPending && retry.variables?.id === id) ||
    (submitForReview.isPending && submitForReview.variables?.id === id);

  const onMove = (taskId: string, from: TaskState, to: TaskState) => {
    const refusal = moveRefusal(from, to, outstandingFor(taskId));
    if (refusal) {
      setDragError(refusal);
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

  /** Opens the "Blocked by" picker for a card — the only way to declare an edge from the board. */
  const blockedByAction = (task: TaskDto): ReactNode => (
    <Button size="xs" variant="ghost" onClick={() => setEditingBlockersFor(task)}>
      <Link2 /> Blocked by
    </Button>
  );

  /**
   * Delete, on every card regardless of state. It sits after the lifecycle buttons and is styled
   * down to a muted icon that only gains its destructive colour on hover — a Task's own delete is
   * reachable in one place on the board, but it should never be the thing the eye lands on first.
   */
  const deleteAction = (task: TaskDto): ReactNode => (
    <DeleteTaskAction
      key={`delete-${task.id}`}
      taskId={task.id}
      taskTitle={task.title}
      trigger={(open) => (
        <Button
          aria-label={`Delete ${task.title}`}
          className="ml-auto text-muted-foreground hover:text-destructive"
          disabled={busy}
          onClick={open}
          size="xs"
          variant="ghost"
        >
          <Trash2 />
        </Button>
      )}
    />
  );

  /**
   * The one-click path from a credential-expired card into the pre-filled Secret form (spec
   * AC-013, issue #63). A plain navigation, not a mutation — renewing the credential itself
   * happens on `secret.set`, on the Settings page this only takes the Owner to.
   */
  const renewAction = (task: TaskDto): ReactNode => {
    if (task.failureReason !== CREDENTIAL_EXPIRED_REASON) return null;
    const credentialName = credentialNameByProfile.get(task.agentProfileId);
    return (
      <Button key={`renew-${task.id}`} asChild size="xs" variant="outline">
        <Link href={`/settings?renewSecret=${encodeURIComponent(credentialName ?? "")}#secrets`}>
          <KeyRound /> Renew
        </Link>
      </Button>
    );
  };

  /**
   * The one-click path back to `running` for a Task that failed for a reason a fresh attempt can
   * actually fix — everything except a credential, which `renewAction` covers instead: retrying
   * before the credential itself changes would only fail the same way again immediately.
   *
   * This is also how an Owner recovers a Task `INTERRUPTED_REASON`'d by the orchestrator's own
   * boot-time reconciliation (an orchestrator restart mid-run with nothing left to redrive it —
   * see `apps/orchestrator/src/reconcile.ts`): the worktree and its commits are untouched, so a
   * retry here is a fresh agent process picking the same work back up, not a restart from zero.
   */
  const retryAction = (task: TaskDto): ReactNode => {
    if (task.state !== "failed" || task.failureReason === CREDENTIAL_EXPIRED_REASON) return null;
    return (
      <Button
        key={`retry-${task.id}`}
        size="xs"
        variant="outline"
        disabled={busy}
        loading={pendingOn(task.id)}
        onClick={() => retry.mutate({ id: task.id })}
      >
        <RotateCcw /> Retry
      </Button>
    );
  };

  const renderActions = (task: TaskDto): ReactNode => {
    if (task.state === "backlog") {
      return (
        <>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            loading={pendingOn(task.id)}
            onClick={() => move.mutate({ id: task.id, to: "ready" })}
          >
            Ready <ArrowRight />
          </Button>
          {blockedByAction(task)}
          {deleteAction(task)}
        </>
      );
    }
    if (task.state === "ready") {
      const outstanding = outstandingFor(task.id);
      // The server refuses a blocked launch either way (`requireUnblocked`); disabling the button
      // is so the Owner learns what is outstanding instead of learning that a click failed.
      if (outstanding.length > 0) {
        return (
          <>
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* A disabled button fires no pointer events, so the tooltip hangs off a wrapper. */}
                  <span className="inline-flex">
                    <Button size="xs" disabled>
                      <Play /> Launch
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{waitingOn(outstanding)}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {blockedByAction(task)}
            {deleteAction(task)}
          </>
        );
      }
      return (
        <>
          <Button
            size="xs"
            disabled={busy}
            loading={pendingOn(task.id)}
            onClick={() => launch.mutate({ id: task.id })}
          >
            <Play /> Launch
          </Button>
          {blockedByAction(task)}
          {deleteAction(task)}
        </>
      );
    }
    // Nothing to declare on a finished Task: an edge into it would only ever be satisfied.
    return (
      <>
        {task.state === "done" ? null : blockedByAction(task)}
        {renewAction(task)}
        {retryAction(task)}
        {deleteAction(task)}
      </>
    );
  };

  // Every server refusal is a wire code, so none of them may reach the banner as-is — see
  // `taskActionMessage`, which owns the whole mapping rather than special-casing one code and
  // letting the rest through (which is how `TASK_CONCURRENCY_CAP_REACHED` ended up on screen).
  const actionMessage = taskActionMessage(actionError?.message);
  const errorMessage = dragError ?? actionMessage;

  return (
    <BoardReferencesProvider value={references}>
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
        <DndBoard
          tasks={tasks}
          renderActions={renderActions}
          blockersFor={blockersFor}
          onMove={onMove}
          onSubmitForReview={(id) => submitForReview.mutate({ id })}
          submittingOn={pendingOn}
        />
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
      <BlockedByDialog
        task={editingBlockersFor}
        tasks={tasks}
        blockers={editingBlockersFor ? (blockersFor(editingBlockersFor.id) ?? []) : []}
        onOpenChange={(open) => {
          if (!open) setEditingBlockersFor(null);
        }}
        onCycle={setCyclePath}
      />
      <DependencyCycleDialog
        path={cyclePath}
        tasks={tasks}
        onOpenChange={(open) => {
          if (!open) setCyclePath(null);
        }}
      />
    </BoardReferencesProvider>
  );
}
