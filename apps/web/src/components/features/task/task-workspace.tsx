"use client";

import type { SessionEventDto, TaskEvent, TaskInputAck } from "@gatecontrol/contracts";
import {
  ArrowLeft,
  Check,
  CornerDownLeft,
  GitBranch,
  MessageSquare,
  RotateCcw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { TaskStateBadge } from "@/components/features/board/task-state-badge";
import { ConfirmAction } from "@/components/features/confirm-action";
import { useTaskStream } from "@/components/hooks/use-task-stream";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { DiffView } from "./diff-view";
import { PermissionRequestDialog, pendingPermission } from "./permission-request-dialog";

function eventText(e: SessionEventDto): string {
  const p = e.payload;
  if (p && typeof p === "object" && "text" in p) return String((p as { text: unknown }).text);
  if (p && typeof p === "object" && "name" in p) return `tool: ${(p as { name: unknown }).name}`;
  return typeof p === "string" ? p : JSON.stringify(p);
}

/** Text a live wire event contributes to the terminal (status/diff events contribute none). */
function liveText(e: TaskEvent): string {
  if (e.kind === "stdout") return e.text;
  if (e.kind === "tool_use") return `tool: ${e.name}\n`;
  // A permission and its answer belong in the terminal transcript too: the dialog is a moment,
  // and a reviewer reading the run afterwards should still see what was asked and what was said.
  if (e.kind === "permission_request") return `permission requested: ${e.title}\n`;
  if (e.kind === "permission_resolved") {
    return `permission ${e.optionId ?? "declined"} (${e.decidedBy})\n`;
  }
  return "";
}

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
  const [ack, setAck] = useState<TaskInputAck | null>(null);
  const onAck = useCallback((next: TaskInputAck) => setAck(next), []);
  const live = useTaskStream(taskId, { onEvent: onLive, onAck });

  const [input, setInput] = useState("");
  const [feedback, setFeedback] = useState("");
  const decide = trpc.review.decide.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
      if (latest?.id) utils.session.get.invalidate({ sessionId: latest.id });
      setFeedback("");
    },
  });

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
  const events = detail.data?.events ?? [];
  // Persisted history first, then anything that arrived live since this view mounted.
  const stdout =
    events
      .filter((e) => e.kind === "stdout")
      .map(eventText)
      .join("") + live.events.map(liveText).join("");
  const inReview = t.state === "review";
  const canDecide = inReview && !decide.isPending;
  // Steering only makes sense while an agent is actually working; once the Task is in review
  // the way to ask for more is "request changes", which is recorded (Principle I).
  const isRunning = t.state === "running";
  const canSteer = isRunning && live.status === "open";
  const branch = t.resultBranch ?? latest?.diffRef ?? null;
  // Derived from the stream rather than held in state, so a reconnect replay reopens a question
  // that is still outstanding and never reopens one already settled (issue #58, AC-4).
  const permission = pendingPermission(live.events);

  const runDecision = (decision: "approve" | "reject" | "request_changes") => {
    if (!latest?.id) return;
    decide.mutate({
      sessionId: latest.id,
      decision,
      ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
    });
  };

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
        request={permission}
        onChoose={(requestId, optionId) => {
          setAck(null);
          live.respondPermission(requestId, optionId);
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
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-2xs text-muted-foreground">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            {branch ?? `base ${t.baseRef ?? "HEAD"}`}
          </p>
        </div>
        <div className="ml-auto shrink-0">
          <StreamIndicator status={live.status} />
        </div>
      </div>

      {/* Panels */}
      <Tabs defaultValue="terminal" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="mx-4 mt-3 self-start">
          <TabsTrigger value="terminal">
            <Terminal className="size-3.5" /> Terminal
          </TabsTrigger>
          <TabsTrigger value="changes">
            <GitBranch className="size-3.5" /> Changes
          </TabsTrigger>
          <TabsTrigger value="conversation">
            <MessageSquare className="size-3.5" /> Conversation
          </TabsTrigger>
        </TabsList>

        <TabsContent value="terminal" className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          <div className="surface-edge flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-[oklch(0.13_0.008_265)]">
            <ScrollArea className="min-h-0 flex-1">
              {stdout ? (
                <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-foreground/85 leading-[1.65]">
                  {stdout}
                </pre>
              ) : (
                <EmptyPanel label="No agent output yet. Launch the task to start a run." />
              )}
            </ScrollArea>
          </div>

          {/* Steering the running agent (TASK-022). */}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              submitInput();
            }}
          >
            <label className="sr-only" htmlFor="agent-input">
              Message the agent
            </label>
            <Input
              id="agent-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!canSteer}
              placeholder={
                isRunning
                  ? "Message the agent…"
                  : "The agent is not running, so there is nothing to steer."
              }
              className="font-mono text-xs"
            />
            <Button type="submit" disabled={!canSteer || !input.trim()}>
              <CornerDownLeft /> Send
            </Button>
            <ConfirmAction
              disabled={!canSteer}
              title="Stop the agent?"
              description="The agent stops where it is. Whatever it has already changed stays in the worktree and goes to review. Nothing is discarded."
              confirmLabel="Stop the agent"
              onConfirm={() => {
                setAck(null);
                live.stopAgent();
              }}
              trigger={
                <Button type="button" variant="outline" disabled={!canSteer}>
                  <Square /> Stop
                </Button>
              }
            />
          </form>
          {ack && !ack.ok && (
            <p className="text-destructive text-xs" role="alert">
              {ACK_MESSAGE[ack.error ?? ""] ?? "The orchestrator refused that message."}
            </p>
          )}
        </TabsContent>

        <TabsContent value="changes" className="min-h-0 flex-1 p-4">
          <DiffView diff={detail.data?.diff ?? null} branch={branch} />
        </TabsContent>

        <TabsContent value="conversation" className="min-h-0 flex-1 p-4">
          <div className="surface-edge h-full overflow-hidden rounded-xl border bg-card">
            <ScrollArea className="h-full">
              {events.length > 0 ? (
                <ul className="divide-y">
                  {events.map((e) => (
                    <li key={e.id} className="flex gap-3 px-4 py-2.5 text-sm">
                      <span className="w-16 shrink-0 pt-px font-mono text-2xs text-muted-foreground/70 uppercase tracking-wider">
                        {e.kind}
                      </span>
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                        {eventText(e)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyPanel label="No conversation yet." />
              )}
            </ScrollArea>
          </div>
        </TabsContent>
      </Tabs>

      {/* Review gate */}
      <div
        className={cn(
          "border-t px-4 py-3 transition-colors",
          // The gate lights up only when it is actually your turn.
          inReview && "border-state-review/25 bg-state-review/[0.045]",
        )}
      >
        {inReview ? (
          <div className="space-y-3">
            <Textarea
              placeholder="Feedback (required to request changes)…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              className="min-h-16 resize-none bg-background/60"
            />
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
                disabled={!canDecide || !feedback.trim()}
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

function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center p-8 text-center text-sm text-muted-foreground/60">
      {label}
    </div>
  );
}
