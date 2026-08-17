"use client";

import type { SessionEventDto } from "@gatecontrol/contracts";
import { ArrowLeft, Check, GitBranch, MessageSquare, RotateCcw, Terminal, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { STATE_BADGE, STATE_LABELS } from "@/lib/task-states";
import { trpc } from "@/trpc/react";

function eventText(e: SessionEventDto): string {
  const p = e.payload;
  if (p && typeof p === "object" && "text" in p) return String((p as { text: unknown }).text);
  if (p && typeof p === "object" && "name" in p) return `tool: ${(p as { name: unknown }).name}`;
  return typeof p === "string" ? p : JSON.stringify(p);
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
    return <p className="p-6 text-muted-foreground text-sm">Loading task…</p>;
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
  const stdout = events
    .filter((e) => e.kind === "stdout")
    .map(eventText)
    .join("");
  const inReview = t.state === "review";
  const canDecide = inReview && !decide.isPending;

  const runDecision = (decision: "approve" | "reject" | "request_changes") => {
    if (!latest?.id) return;
    decide.mutate({
      sessionId: latest.id,
      decision,
      ...(feedback.trim() ? { feedback: feedback.trim() } : {}),
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Task header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Button asChild variant="ghost" size="icon" className="size-8">
          <Link href="/board" aria-label="Back to board">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-semibold text-sm">{t.title}</h1>
            <Badge variant={STATE_BADGE[t.state]}>{STATE_LABELS[t.state]}</Badge>
          </div>
          <p className="truncate font-mono text-muted-foreground text-xs">
            {t.resultBranch ?? latest?.diffRef ?? `base ${t.baseRef ?? "HEAD"}`}
          </p>
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

        <TabsContent value="terminal" className="min-h-0 flex-1 p-4">
          <ScrollArea className="h-full rounded-md border bg-card">
            {stdout ? (
              <pre className="whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">
                {stdout}
              </pre>
            ) : (
              <EmptyPanel label="No agent output yet. Launch the task to start a run." />
            )}
          </ScrollArea>
        </TabsContent>

        <TabsContent value="changes" className="min-h-0 flex-1 p-4">
          <div className="h-full rounded-md border bg-card p-4">
            {latest?.diffRef || t.resultBranch ? (
              <p className="font-mono text-sm">
                Proposed changes on{" "}
                <span className="text-primary">{t.resultBranch ?? latest?.diffRef}</span>
              </p>
            ) : (
              <EmptyPanel label="No proposed changes yet." />
            )}
          </div>
        </TabsContent>

        <TabsContent value="conversation" className="min-h-0 flex-1 p-4">
          <ScrollArea className="h-full rounded-md border bg-card">
            {events.length > 0 ? (
              <ul className="divide-y">
                {events.map((e) => (
                  <li key={e.id} className="px-4 py-2 text-sm">
                    <span className="mr-2 font-mono text-muted-foreground text-xs uppercase">
                      {e.kind}
                    </span>
                    {eventText(e)}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyPanel label="No conversation yet." />
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>

      {/* Review gate */}
      <div className="border-t p-4">
        {inReview ? (
          <div className="space-y-3">
            <Textarea
              placeholder="Feedback (required to request changes)…"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              className="min-h-16"
            />
            <div className="flex items-center gap-2">
              <Button disabled={!canDecide} onClick={() => runDecision("approve")}>
                <Check /> Approve
              </Button>
              <Button
                variant="outline"
                disabled={!canDecide || !feedback.trim()}
                onClick={() => runDecision("request_changes")}
              >
                <RotateCcw /> Request changes
              </Button>
              <Button
                variant="outline"
                disabled={!canDecide}
                onClick={() => runDecision("reject")}
                className="text-destructive hover:text-destructive"
              >
                <X /> Reject
              </Button>
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
    <div className="flex h-full items-center justify-center p-8 text-muted-foreground text-sm">
      {label}
    </div>
  );
}
