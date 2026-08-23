"use client";

import type {
  SessionEventDto,
  SessionSummaryDto,
  TaskEvent,
  TaskInputAck,
  TaskState,
} from "@gatecontrol/contracts";
import { DEFAULT_TASK_PANE_LAYOUT, type TaskPaneLayout } from "@gatecontrol/contracts";
import { primaryTaskRepository } from "@gatecontrol/core";
import {
  ArrowLeft,
  Check,
  GitBranch,
  ListChecks,
  MessageSquare,
  RotateCcw,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { TaskStateBadge } from "@/components/features/board/task-state-badge";
import { ConfirmAction, ConfirmDialog } from "@/components/features/confirm-action";
import { useTaskStream } from "@/components/hooks/use-task-stream";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { taskActionMessage } from "@/lib/task-errors";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { AgentComposer } from "./agent-composer";
import { DeleteTaskAction } from "./delete-task-action";
import { DiffView } from "./diff-view";
import { type PermissionRequest, PermissionRequestDialog } from "./permission-request-dialog";
import { SessionLog } from "./session-log";
import { SplitPane } from "./split-pane";
import { TaskAdvance } from "./task-advance";
import { TerminalView } from "./terminal-view";
import { latestTodos, TodoList } from "./todo-list";
import { buildTranscript, openPermission, type PermissionRow } from "./transcript";

/** Shared empty array, so "no events yet" keeps a stable identity across renders. */
const NO_EVENTS: SessionEventDto[] = [];

const STREAM_LABEL: Record<string, string> = {
  idle: "Not streaming",
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  error: "Stream offline",
};

/** Connection health, told by colour as well as by word. */
const STREAM_TONE: Record<string, string> = {
  idle: "text-muted-foreground/60",
  connecting: "text-muted-foreground",
  open: "text-state-done",
  reconnecting: "text-state-review",
  error: "text-state-failed",
};

/** What the hub said about the last thing we sent, in words an operator can act on. */
const ACK_MESSAGE: Record<string, string> = {
  agent_not_running: "No agent is running for this task. Nothing was sent.",
  frame_not_authorized: "This connection is not allowed to steer that task.",
  frame_malformed: "The message could not be read by the orchestrator.",
  // The agent is still running in all three of these; only the question is over.
  permission_not_pending: "That request was already settled — by the deadline, or by someone else.",
  permission_option_unknown: "The agent no longer offers that option.",
  permission_unsupported: "This agent's protocol has no permission channel to answer on.",
};

/** Live connection indicator: a dot that pulses only while the stream is actually open. */
function StreamIndicator({ status }: { status: string }) {
  return (
    <span
      className={cn("flex items-center gap-1.5 text-2xs", STREAM_TONE[status])}
      aria-live="polite"
      data-stream-status={status}
    >
      <span className="relative flex size-1.5">
        {status === "open" && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        )}
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
      {STREAM_LABEL[status]}
    </span>
  );
}

/** The IDE-like Task workspace: agent terminal + git changes + conversation + review gate. */
export function TaskWorkspace({ taskId }: { taskId: string }) {
  const utils = trpc.useUtils();
  const task = trpc.task.get.useQuery({ id: taskId });
  const sessions = trpc.session.listForTask.useQuery({ taskId });
  const latest = sessions.data?.[0];
  const detail = trpc.session.get.useQuery(
    { sessionId: latest?.id ?? "" },
    { enabled: Boolean(latest?.id) },
  );

  // Live agent stream (TASK-018): output arrives as the agent produces it, and a state change
  // refetches the Task so the review gate opens without a reload. Replay on reconnect means the
  // terminal keeps its history across a dropped connection.
  const onLive = useCallback(
    (event: TaskEvent) => {
      if (event.kind === "status" || event.kind === "diff") {
        utils.task.get.invalidate({ id: taskId });
        utils.session.listForTask.invalidate({ taskId });
      }
    },
    [utils, taskId],
  );
  const [tab, setTab] = useState("terminal");
  const [ack, setAck] = useState<TaskInputAck | null>(null);
  const onAck = useCallback((next: TaskInputAck) => setAck(next), []);
  const live = useTaskStream(taskId, { onEvent: onLive, onAck });
  const router = useRouter();

  /**
   * The split between the run and the change under review — a per-user preference, so the
   * arrangement follows the person rather than the browser (issue #3, AC-3).
   *
   * Optimistic: the divider must track the pointer, and a column that snapped back while a
   * round trip completed would be unusable. The mutation is fired on release, not per move, so
   * one drag is one write.
   */
  const paneQuery = trpc.preference.getTaskPaneLayout.useQuery({});
  const [paneOverride, setPaneOverride] = useState<TaskPaneLayout | null>(null);
  const savePaneMutation = trpc.preference.setTaskPaneLayout.useMutation();
  const pane = paneOverride ?? paneQuery.data?.layout ?? DEFAULT_TASK_PANE_LAYOUT;
  const savePane = useCallback(
    (next: TaskPaneLayout) => {
      setPaneOverride(next);
      savePaneMutation.mutate(next);
    },
    [savePaneMutation],
  );

  /**
   * The transcript, built once per change rather than per render.
   *
   * Above the loading and error guards on purpose: it is a hook, and a hook after an early
   * return is a hook that sometimes does not run — which React detects as a change in hook
   * order and refuses.
   *
   * `buildTranscript` also deduplicates its two sources against each other. The socket replays
   * from the beginning on its first connection, so every event of an already-started Task
   * arrives both here and from `session.get`; the old terminal concatenated the two and showed
   * the whole run twice.
   */
  // `?? NO_EVENTS` rather than `?? []`: a fresh literal is a new identity on every render, which
  // would make the memo below miss every time and rebuild the whole transcript per render —
  // reintroducing, quietly, the cost this replaced.
  const events = detail.data?.events ?? NO_EVENTS;
  const rows = useMemo(() => buildTranscript(events, live.events), [events, live.events]);

  /**
   * The agent's own plan, read from both of the page's sources for the same reason `rows` is.
   *
   * `session.get` holds the list as it stood when the query ran and the socket holds everything
   * since, so a `TodoWrite` mid-run has to reach the panel from the stream or the plan would sit
   * a reload behind the work it describes.
   *
   * Live wins outright when it has anything to say, rather than being merged: the socket resumes
   * from `seq` -1 on a first connection and from the last seq seen on a reconnect, so its copy of
   * the list is never the older of the two. The narrowing to the session on screen is the part
   * that is not obvious — `seq` restarts per Session, and a replay reaching back into an earlier
   * review round would otherwise let that round's final list win on array position alone.
   */
  const liveSessionId = latest?.id;
  const todos = useMemo(() => {
    for (let i = live.events.length - 1; i >= 0; i -= 1) {
      const event = live.events[i];
      if (event?.kind === "todos" && event.sessionId === liveSessionId) return event.items;
    }
    return latestTodos(events);
  }, [events, live.events, liveSessionId]);

  // Read one summarised range back when an operator opens it (issue #2, AC-3). `session.get`
  // leaves those events out — that is what compaction buys — and this is how they come back,
  // one range at a time instead of on every load of the workspace.
  const loadRange = useCallback(
    (summary: SessionSummaryDto) =>
      utils.session.eventRange.fetch({
        sessionId: summary.sessionId,
        fromSeq: summary.fromSeq,
        toSeq: summary.toSeq,
      }),
    [utils],
  );

  const [input, setInput] = useState("");
  const decide = trpc.review.decide.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
      if (latest?.id) utils.session.get.invalidate({ sessionId: latest.id });
    },
  });

  /**
   * Moving the Task along its lifecycle without going back to the board.
   *
   * The board owns the same mutation, and this is a second call site for it rather than a shared
   * one on purpose: the two disagree about everything except the request. The board spins one
   * card out of dozens and re-reads the dependency graph; here there is one Task, and what has to
   * be re-read is the Task itself, because the header badge and the review gate below are both
   * drawn from it.
   */
  const move = trpc.task.move.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
    },
  });
  /**
   * Starting the agent, from the same arrow that would otherwise only have written the state.
   *
   * `task.move` into `running` is accepted by the server — the transition is legal — and does
   * nothing else: no Session is created and no launch is published. The Task page has no Launch
   * button of its own, so the forward arrow on a Ready Task is the obvious way to begin a run
   * here, and a bare move would leave a Task that reads as Running with no agent behind it,
   * holding one of the Agent Profile's concurrency slots and with no way back — `running` has no
   * legal retreat, and `task.launch` refuses a Task that is no longer Ready.
   */
  const launch = trpc.task.launch.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
      utils.session.listForTask.invalidate({ taskId });
    },
  });
  const [pendingMove, setPendingMove] = useState<TaskState | null>(null);

  if (task.isLoading) {
    return (
      <div className="space-y-3 p-6" aria-hidden>
        <div className="h-4 w-64 animate-pulse rounded-full bg-muted" />
        <div className="h-[60vh] animate-pulse rounded-xl border bg-card" />
      </div>
    );
  }
  if (task.error || !task.data) {
    return (
      <p className="p-6 text-destructive text-sm" role="alert">
        {task.error?.message ?? "Task not found"}
      </p>
    );
  }

  const t = task.data;
  const summaries = detail.data?.summaries ?? [];
  // Persisted history first, then anything that arrived live since this view mounted. A
  // compacted Session no longer ships the events its summaries stand in for, so the terminal
  // says what it is missing rather than quietly starting mid-run; the Conversation tab is where
  // a collapsed range can be opened back up.
  const elided = summaries.reduce((n, s) => n + s.eventCount, 0);
  const inReview = t.state === "review";
  const canDecide = inReview && !decide.isPending;
  // Steering only makes sense while an agent is actually working; once the Task is in review
  // the way to ask for more is "request changes", which is recorded (Principle I).
  const isRunning = t.state === "running";
  const canSteer = isRunning && live.status === "open";
  // The primary attachment's branch (issue #7). The header has room for one line, so it names
  // the repository the agent actually ran in; the Changes tab is where every repository's own
  // branch and change is shown.
  const primary = t.repositories.length > 0 ? primaryTaskRepository(t.repositories) : null;
  const branch = primary?.resultBranch ?? latest?.diffRef ?? null;
  const diffs = detail.data?.diffs ?? [];
  // Derived from the transcript rather than held in state, so a reconnect replay reopens a
  // question that is still outstanding and never reopens one already settled (issue #58, AC-4).
  // It reads the built rows instead of rescanning `live.events` on every render, and it sees the
  // persisted history too — a question asked before this view mounted is now found as well.
  const permission = openPermission(rows);

  // The inline card in the transcript is the primary surface for a permission: the modal traps
  // focus, so with it open an operator cannot read the tool call they are being asked about.
  // The modal is kept only as the escalation — when the question is on a panel the operator is
  // not looking at, something has to interrupt them, because an agent is blocked on the answer.
  const permissionOutOfView = permission !== null && tab !== "terminal";

  const runDecision = (decision: "approve" | "reject" | "request_changes") => {
    if (!latest?.id) return;
    decide.mutate({ sessionId: latest.id, decision });
  };

  /**
   * One step along the lifecycle, from the arrows beside the state badge.
   *
   * Two of the steps are not the plain state write they look like. Starting a Ready Task is a
   * launch, and goes through the mutation that actually creates a Session. Leaving Review throws
   * something away — the agent's proposed changes are abandoned and no review decision is
   * recorded — so it asks first, in the words the board asks in (TASK-022) when the move is
   * backwards, and in its own words for Done, where the thing being lost is the commit.
   */
  const requestMove = (to: TaskState) => {
    if (to === "running" && t.state === "ready") {
      launch.mutate({ id: t.id });
      return;
    }
    if (t.state === "review") {
      setPendingMove(to);
      return;
    }
    move.mutate({ id: t.id, to });
  };

  // Every server refusal arrives as a wire code, so none of them may reach the banner as-is —
  // `taskActionMessage` owns the whole mapping, the same one the board's banner reads through.
  const moveMessage = taskActionMessage(move.error?.message ?? launch.error?.message);

  const submitInput = () => {
    const text = input.trim();
    if (!text || !canSteer) return;
    setAck(null);
    if (live.sendInput(text)) setInput("");
  };

  return (
    <div className="flex h-full flex-col">
      {/* The agent asking for something it cannot decide alone (issue #58, AC-4). */}
      <PermissionRequestDialog
        request={permissionOutOfView && permission ? toDialogRequest(permission) : null}
        onChoose={(requestId, optionId) => {
          setAck(null);
          live.respondPermission(requestId, optionId);
        }}
      />

      {/*
        Leaving Review, asked in the terms of the direction being taken.

        Backwards is the board's own question, in the board's words (TASK-022): an operator who
        learned what it means there should not have to learn it again here. Forwards is a
        different act and cannot borrow that wording — pointing someone who just pressed "Move to
        Done" at Reject describes the opposite of what they asked for. What Done actually skips is
        the approve step: `task.move` writes the state and nothing else, so the agent's branch is
        never committed and the run is left waiting at a gate no decision ever reaches.
      */}
      <ConfirmDialog
        open={pendingMove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingMove(null);
        }}
        title={
          pendingMove === "done"
            ? "Mark this task done without approving?"
            : "Move this task out of review?"
        }
        description={
          pendingMove === "done"
            ? "No review decision is recorded and nothing is committed — the agent's changes stay on their branch and the task cannot be moved again. To accept the work and commit it, use Approve below."
            : "The agent's proposed changes are left behind and no review decision is recorded. To reject the work properly, and keep the audit trail, use Reject below."
        }
        confirmLabel="Move it anyway"
        onConfirm={() => {
          if (pendingMove) move.mutate({ id: t.id, to: pendingMove });
          setPendingMove(null);
        }}
      />

      {/* Task header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href="/board" aria-label="Back to board">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-semibold text-sm">{t.title}</h1>
            <TaskStateBadge state={t.state} size="sm" />
            {/*
              Beside the badge rather than in the action cluster on the right: the arrows change
              exactly the thing the badge shows, and a control placed away from its own readout
              leaves the operator checking two corners of the header to see what they just did.
            */}
            <TaskAdvance
              state={t.state}
              onMove={requestMove}
              pending={move.isPending || launch.isPending}
            />
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-2xs text-muted-foreground">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            {branch ?? `base ${primary?.baseRef ?? "HEAD"}`}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <StreamIndicator status={live.status} />
          {/*
            Deleting the Task the page is *about* leaves nowhere to stand, so it navigates back
            to the board rather than re-rendering against a Task that no longer exists.
          */}
          <DeleteTaskAction
            onDeleted={() => router.push("/board")}
            taskId={t.id}
            taskTitle={t.title}
            trigger={(openDialog) => (
              <Button
                aria-label={`Delete ${t.title}`}
                className="text-muted-foreground hover:text-destructive"
                onClick={openDialog}
                size="icon"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            )}
          />
        </div>
      </div>

      {moveMessage ? (
        <p
          className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-state-failed/30 bg-state-failed/10 px-3 py-2 text-state-failed text-sm"
          role="alert"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          {moveMessage}
        </p>
      ) : null}

      {/* Panels: the run on the left, the change under review in a column beside it. */}
      <SplitPane
        collapsed={pane.changesCollapsed}
        left={
          <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsList className="mx-4 mt-3 self-start">
              <TabsTrigger value="terminal">
                <Terminal className="size-3.5" /> Terminal
              </TabsTrigger>
              <TabsTrigger value="conversation">
                <MessageSquare className="size-3.5" /> Conversation
              </TabsTrigger>
            </TabsList>

            <TabsContent value="terminal" className="flex min-h-0 flex-1 flex-col gap-2 p-4">
              <TerminalView
                rows={rows}
                elided={elided}
                // What lets the panel say "launching" over an empty terminal and name what the
                // agent is doing under a quiet one — both are only true while a run is alive.
                isRunning={isRunning}
                onRespondPermission={live.respondPermission}
                // Answering means reaching a live agent, so the control is offered only while
                // there is one: a finished run keeps its widgets as a record.
                {...(isRunning ? { onRespondWidget: live.respondWidget } : {})}
              />

              <AgentComposer
                value={input}
                onChange={setInput}
                onSubmit={submitInput}
                onStop={() => {
                  setAck(null);
                  live.stopAgent();
                }}
                canSteer={canSteer}
                isRunning={isRunning}
              />
              {ack && !ack.ok && (
                <p className="text-destructive text-xs" role="alert">
                  {ACK_MESSAGE[ack.error ?? ""] ?? "The orchestrator refused that message."}
                </p>
              )}
            </TabsContent>

            <TabsContent value="conversation" className="min-h-0 flex-1 p-4">
              <div className="surface-edge h-full overflow-hidden rounded-xl border bg-card">
                <ScrollArea className="h-full">
                  <SessionLog events={events} summaries={summaries} loadRange={loadRange} />
                </ScrollArea>
              </div>
            </TabsContent>
          </Tabs>
        }
        onResize={(changesWidth) => savePane({ ...pane, changesWidth })}
        onToggle={(changesCollapsed) => savePane({ ...pane, changesCollapsed })}
        right={
          <ScrollArea className="h-full">
            <div className="p-3">
              {/*
            One group per Repository (issue #7 AC-4). A Task can span several, and a reviewer
            shown one flat file list could not tell which repository a path came from —
            `DiffView` is reused unchanged inside each group rather than learning to group.
            With one repository there is no header at all, so a single-Repository Task looks
            exactly as it did.
          */}
              {diffs.length > 1 ? (
                <ScrollArea className="h-full">
                  <div className="space-y-4">
                    {diffs.map((entry, index) => (
                      <section
                        key={entry.repositoryId ?? entry.diffRef ?? index}
                        aria-label={`Changes in ${entry.repositoryName ?? entry.diffRef}`}
                      >
                        <h2 className="mb-2 flex items-center gap-2 font-medium text-sm">
                          <GitBranch
                            className="size-3.5 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate">
                            {entry.repositoryName ?? "Unnamed repository"}
                          </span>
                          <span className="truncate font-mono text-2xs text-muted-foreground">
                            {entry.diffRef}
                          </span>
                          <span className="shrink-0 font-mono text-2xs text-muted-foreground/70">
                            {entry.files.length} file{entry.files.length === 1 ? "" : "s"}
                          </span>
                        </h2>
                        <DiffView diff={entry} branch={entry.diffRef} />
                      </section>
                    ))}
                  </div>
                </ScrollArea>
              ) : (
                <DiffView diff={diffs[0] ?? null} branch={branch} />
              )}

              {/*
                Plan under result, in the column that is already about what the agent did. The
                two answer the reviewer's question from opposite ends — the diff says what has
                landed, the checklist says what the agent still believes is outstanding — and a
                reviewer looking at a half-finished change needs to know which of the two they
                are seeing. It sits below because the change is what the panel is for; the plan
                is context for it.

                Nothing at all when the agent has published no list: `TodoList` renders `null` on
                an empty one, and a heading over nothing would claim a plan exists.
              */}
              {todos.length > 0 ? (
                <section aria-label="Agent plan" className="mt-4">
                  <h2 className="mb-2 flex items-center gap-2 font-medium text-sm">
                    <ListChecks className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    Plan
                  </h2>
                  <TodoList items={todos} />
                </section>
              ) : null}
            </div>
          </ScrollArea>
        }
        rightLabel="Changes"
        width={pane.changesWidth}
      />

      {/* Review gate */}
      <div
        className={cn(
          "border-t px-4 py-3 transition-colors",
          // The gate lights up only when it is actually your turn.
          inReview && "border-state-review/25 bg-state-review/[0.045]",
        )}
      >
        {inReview ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="lg"
              disabled={!canDecide}
              loading={decide.isPending && decide.variables?.decision === "approve"}
              onClick={() => runDecision("approve")}
            >
              <Check /> Approve
            </Button>
            <Button
              size="lg"
              variant="outline"
              disabled={!canDecide}
              loading={decide.isPending && decide.variables?.decision === "request_changes"}
              onClick={() => runDecision("request_changes")}
            >
              <RotateCcw /> Request changes
            </Button>
            <ConfirmAction
              disabled={!canDecide}
              title="Reject these changes?"
              description="The agent's work is discarded and the worktree is torn down. This cannot be undone. The task returns to Ready and would have to run again from scratch."
              confirmLabel="Discard the changes"
              onConfirm={() => runDecision("reject")}
              trigger={
                <Button
                  size="lg"
                  variant="ghost"
                  disabled={!canDecide}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <X /> Reject
                </Button>
              }
            />
            {decide.error && (
              <span className="text-destructive text-sm" role="alert">
                {decide.error.message}
              </span>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Review actions become available when the agent submits changes and the task enters{" "}
            <span className="font-medium text-foreground">Review</span>.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A transcript row as the modal's wire-shaped request.
 *
 * The modal predates the transcript model and speaks `TaskEvent`; rather than teach it a second
 * shape, the one caller that still needs it converts. `taskId` is not read by the dialog — it
 * keys on `requestId` — so the row's own session is enough to identify the question.
 */
function toDialogRequest(row: PermissionRow): PermissionRequest {
  return {
    kind: "permission_request",
    taskId: "",
    sessionId: row.sessionId,
    seq: row.seq,
    requestId: row.requestId,
    title: row.title,
    toolKind: row.toolKind,
    toolCallId: row.toolCallId,
    options: row.options,
  };
}
