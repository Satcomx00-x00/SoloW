"use client";

import type { HistoryEntryDto, TaskDto } from "@solow/contracts";
import { TASK_RETENTION_DAYS } from "@solow/core";
import { ArchiveRestore, History, MessageSquareText, Play, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { TaskCard } from "@/components/features/board/task-card";
import { ConfirmAction } from "@/components/features/confirm-action";
import {
  LaunchTaskDialog,
  useWorkflowChoices,
} from "@/components/features/task/launch-task-dialog";
import { Button } from "@/components/ui/button";
import { relativeAge, relativeUntil } from "@/lib/relative-time";
import { taskActionMessage } from "@/lib/task-errors";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * History (spec F02 FR-10, F11; Decision 0025): what was closed or deleted in the last
 * `TASK_RETENTION_DAYS`, and the way back for each.
 *
 * One list, newest first, rather than two tabs: "the thing I just lost" is the question this
 * page answers, and the operator asking it does not always remember whether they deleted the
 * Task or finished it. Each row says which, when, how long it has left, and — the fact the
 * whole feature exists for — whether resuming it *continues the conversation* or starts again
 * from the brief.
 *
 * The rows are the board's own cards, so a Task looks the same here as it did there. The
 * actions are the Task page's own procedures: nothing on this page has a rule of its own.
 */
export function HistoryView() {
  const history = trpc.history.list.useQuery({});
  const utils = trpc.useUtils();
  const refresh = () => {
    void utils.history.list.invalidate();
    void utils.task.list.invalidate();
    void utils.task.get.invalidate();
  };
  const restore = trpc.task.restore.useMutation({ onSuccess: refresh });
  const move = trpc.task.move.useMutation({ onSuccess: refresh });
  const launch = trpc.task.launch.useMutation({ onSuccess: refresh });
  // Reopening a Done Task and launching it are two procedures with one gesture here: the row
  // said what the launch would do, and a person who read that has decided. Workflows, when the
  // Workspace has any, are asked about first — the same dialog the board and the Task page use.
  const workflowChoices = useWorkflowChoices();
  const [launching, setLaunching] = useState<TaskDto | null>(null);
  const resume = async (task: TaskDto) => {
    const reopened = await move.mutateAsync({ id: task.id, to: "ready" });
    if (workflowChoices.available) setLaunching(reopened);
    else launch.mutate({ id: reopened.id });
  };

  const error = taskActionMessage(
    restore.error?.message ?? move.error?.message ?? launch.error?.message,
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-6 py-8">
      <LaunchTaskDialog
        task={launching}
        onOpenChange={(open) => {
          if (!open) setLaunching(null);
        }}
        onLaunch={(task) => launch.mutate({ id: task.id })}
      />
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 font-semibold text-lg">
          <History aria-hidden className="size-4 text-muted-foreground" />
          History
        </h1>
        <p className="text-muted-foreground text-sm">
          Tasks closed or deleted in the last {TASK_RETENTION_DAYS} days. A deleted task can be
          restored; a finished one can be reopened and resumed. After that, its worktree — and with
          it the harness's conversation — is removed.
        </p>
      </header>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}

      {history.isLoading ? (
        <div className="space-y-2" aria-hidden>
          <div className="h-16 animate-pulse rounded-xl border bg-card" />
          <div className="h-16 animate-pulse rounded-xl border bg-card" />
        </div>
      ) : history.data && history.data.length > 0 ? (
        <ul className="space-y-3" aria-label="History">
          {history.data.map((entry) => (
            <li key={entry.task.id} className="space-y-1.5">
              <TaskCard
                task={entry.task}
                actions={
                  <Actions
                    entry={entry}
                    pending={
                      (restore.isPending && restore.variables?.id === entry.task.id) ||
                      (move.isPending && move.variables?.id === entry.task.id) ||
                      (launch.isPending && launch.variables?.id === entry.task.id)
                    }
                    onRestore={() => restore.mutate({ id: entry.task.id })}
                    onResume={() => void resume(entry.task)}
                  />
                }
              />
              <Caption entry={entry} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="surface-edge flex min-h-40 flex-col items-center justify-center gap-1 rounded-xl border bg-card px-6 text-center">
          <p className="font-medium text-sm">Nothing in history</p>
          <p className="max-w-sm text-muted-foreground text-xs leading-relaxed">
            A task you delete, or one that reaches Done, stays here for {TASK_RETENTION_DAYS} days.
          </p>
        </div>
      )}
    </div>
  );
}

/** What resuming this row would do, said before the button that does it. */
const RESUME_LABEL: Record<HistoryEntryDto["resumable"], string> = {
  conversation: "conversation continues",
  brief: "starts again from the brief",
  none: "never ran",
};

function Caption({ entry }: { entry: HistoryEntryDto }) {
  return (
    <p
      className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-2xs text-muted-foreground"
      data-history-caption={entry.task.id}
    >
      <span className="font-medium text-foreground/80">
        {entry.kind === "deleted" ? "Deleted" : "Done"} {relativeAge(entry.since)}
      </span>
      {entry.issueTitle ? (
        <>
          <span aria-hidden>·</span>
          <Link
            href={`/issues/${entry.task.issueId}`}
            className="truncate hover:text-foreground hover:underline"
          >
            {entry.issueTitle}
          </Link>
        </>
      ) : null}
      {entry.repositoryName ? (
        <>
          <span aria-hidden>·</span>
          <span className="font-mono">{entry.repositoryName}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span>
        {entry.kind === "deleted" ? "purged" : "worktree removed"} {relativeUntil(entry.expiresAt)}
      </span>
      <span aria-hidden>·</span>
      <span
        className={cn(
          "inline-flex items-center gap-1",
          entry.resumable === "conversation" && "text-feedback-ok",
        )}
      >
        {entry.resumable === "conversation" ? (
          <MessageSquareText aria-hidden className="size-3" />
        ) : null}
        {RESUME_LABEL[entry.resumable]}
      </span>
    </p>
  );
}

function Actions({
  entry,
  pending,
  onRestore,
  onResume,
}: {
  entry: HistoryEntryDto;
  pending: boolean;
  onRestore: () => void;
  onResume: () => void;
}) {
  if (entry.kind === "deleted") {
    return (
      <Button size="xs" variant="outline" loading={pending} onClick={onRestore}>
        <ArchiveRestore /> Restore
      </Button>
    );
  }
  // A finished Task: reopening it and starting a harness are one decision here, and the
  // caption under the card has already said what that harness will find.
  return (
    <ConfirmAction
      tone="neutral"
      title={`Reopen "${entry.task.title}" and resume it?`}
      description={
        entry.resumable === "conversation"
          ? "The task goes back to Ready and a run starts in its kept worktree, continuing the harness's previous conversation."
          : entry.resumable === "brief"
            ? "The task goes back to Ready and a run starts from the task brief — the previous conversation is not available to continue."
            : "The task goes back to Ready and a run starts from the task brief."
      }
      confirmLabel="Reopen and resume"
      onConfirm={onResume}
      trigger={
        <Button size="xs" loading={pending}>
          {entry.resumable === "conversation" ? <Play /> : <RotateCcw />} Reopen &amp; resume
        </Button>
      }
    />
  );
}
