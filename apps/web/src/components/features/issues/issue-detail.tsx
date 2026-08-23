"use client";

import type { TaskDependencyDto } from "@gatecontrol/contracts";
import { ArrowLeft, ExternalLink, Pencil, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TaskCard } from "@/components/features/board/task-card";
import { TaskStateBadge } from "@/components/features/board/task-state-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ISSUE_SOURCE_LABELS } from "@/lib/issue-status";
import { trpc } from "@/trpc/react";
import { DeleteIssueAction } from "./delete-issue-action";
import { IssueFormDialog } from "./issue-form-dialog";
import { IssueStatusControl } from "./issue-status-control";

/**
 * One Issue and the Tasks cut from it.
 *
 * The board answers "what is every agent doing right now"; this answers "how far along is this
 * one piece of work" — the same Tasks, grouped by intent instead of by lifecycle. Both read the
 * same `task.list`, filtered by `issueId` here.
 */
export function IssueDetail({ issueId }: { issueId: string }) {
  const router = useRouter();
  const issue = trpc.issue.get.useQuery({ id: issueId });
  const tasks = trpc.task.list.useQuery({ issueId }, { enabled: issue.isSuccess });
  // The Workspace's `blocked_by` edges (issue #6), so a blocked Task reads as blocked here too
  // rather than only on the board. Waited on rather than defaulted to empty: a card drawn before
  // the edges land would say "ready to run" about work that cannot run (AC-4).
  const dependencies = trpc.task.dependencies.useQuery({}, { enabled: issue.isSuccess });

  if (issue.isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-3 px-6 py-5" aria-hidden>
        <div className="h-5 w-72 animate-pulse rounded-full bg-muted" />
        <div className="h-24 animate-pulse rounded-lg border bg-card" />
      </div>
    );
  }

  if (issue.error || !issue.data) {
    return (
      <div
        className="mx-auto flex w-full max-w-3xl items-start gap-2.5 px-6 py-10 text-sm"
        role="alert"
      >
        <TriangleAlert className="mt-px size-4 shrink-0 text-state-failed" aria-hidden />
        <div>
          <p className="font-medium">Issue not available</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {issue.error?.message ?? "Issue not found"}
          </p>
        </div>
      </div>
    );
  }

  const data = issue.data;
  const rows = tasks.data ?? [];
  const blockersByTask = new Map<string, TaskDependencyDto[]>();
  for (const edge of dependencies.data ?? []) {
    const existing = blockersByTask.get(edge.taskId);
    if (existing) existing.push(edge);
    else blockersByTask.set(edge.taskId, [edge]);
  }
  const tasksError = tasks.error ?? dependencies.error;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-6 py-5">
      <div className="flex items-start gap-3">
        <Button asChild variant="ghost" size="icon" className="-ml-1 shrink-0">
          <Link href="/issues" aria-label="Back to issues">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
            <h1 className="font-semibold text-base leading-snug">{data.title}</h1>
            <IssueStatusControl issue={data} />
          </div>
          {/* Where an imported Issue actually lives (spec F01 FR-4). GateControl owns its Tasks
              and its status; the title and description on this page are a copy of the
              provider's, and this is the link back to the original. */}
          {data.externalUrl && (
            <a
              href={data.externalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
            >
              <span>{ISSUE_SOURCE_LABELS[data.source]}</span>
              {data.externalNumber !== null && (
                <span className="font-mono">#{data.externalNumber}</span>
              )}
              <ExternalLink aria-hidden className="size-3" />
              {data.syncedAt && (
                <span className="text-muted-foreground/70">
                  · synced {new Date(data.syncedAt).toLocaleDateString()}
                </span>
              )}
            </a>
          )}
          {data.description && (
            <p className="mt-2 max-w-prose whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
              {data.description}
            </p>
          )}
          {data.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.labels.map((label) => (
                <Badge key={label} variant="secondary">
                  {label}
                </Badge>
              ))}
            </div>
          )}
        </div>
        {/* `max-w-48` + `flex-wrap` so DeleteIssueAction's error text (if the delete is refused)
            drops to its own line instead of stretching this header row. */}
        <div className="flex max-w-48 shrink-0 flex-wrap items-center justify-end gap-1">
          <IssueFormDialog
            issue={data}
            trigger={
              <Button variant="ghost" size="icon" aria-label="Edit issue">
                <Pencil />
              </Button>
            }
          />
          <DeleteIssueAction
            issueId={data.id}
            issueTitle={data.title}
            onSuccess={() => router.push("/issues")}
            trigger={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Delete issue"
                className="text-destructive hover:text-destructive"
              >
                <Trash2 />
              </Button>
            }
          />
        </div>
      </div>

      <section aria-label="Tasks for this issue" className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="font-medium text-sm">Tasks</h2>
          <span className="font-mono text-muted-foreground text-xs tabular-nums">
            {rows.length}
          </span>
        </div>

        {(tasks.isLoading || dependencies.isLoading) && (
          <div className="h-20 animate-pulse rounded-lg border bg-card" aria-hidden />
        )}

        {tasksError && (
          <p className="flex items-start gap-2.5 text-sm" role="alert">
            <TriangleAlert className="mt-px size-4 shrink-0 text-state-failed" aria-hidden />
            <span>
              Tasks not available
              <span className="mt-0.5 block font-mono text-muted-foreground text-xs">
                {tasksError.message}
              </span>
            </span>
          </p>
        )}

        {tasks.isSuccess &&
          dependencies.isSuccess &&
          (rows.length === 0 ? (
            <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
              Nothing has been cut from this issue yet. Create a task on the board to hand a slice
              of it to an agent.
            </p>
          ) : (
            <ul className="space-y-2">
              {rows.map((task) => (
                <li key={task.id} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <TaskCard task={task} blockers={blockersByTask.get(task.id)} />
                  </div>
                  {/* Grouped by intent here, so each row has to say its own lifecycle state. */}
                  <TaskStateBadge state={task.state} size="sm" className="mt-2.5 shrink-0" />
                </li>
              ))}
            </ul>
          ))}
      </section>
    </div>
  );
}
