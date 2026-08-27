"use client";

import type { TaskDeletionImpactDto } from "@solow/contracts";
import type { ReactNode } from "react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { taskActionMessage } from "@/lib/task-errors";
import { trpc } from "@/trpc/react";

/**
 * Delete a Task, from wherever a Task is shown — the board card and the Task page both mount
 * this, so the wording, the counts and the refusals are identical in both places.
 *
 * One dialog, not the Issue delete's two. There the first gate exists because the *ordinary*
 * delete is the safe one and the cascade is the exception; here every delete takes the Task's
 * sessions with it, so a second confirmation would only ask the same question twice. The
 * dependents case is folded into the same dialog: the copy states that other Tasks are waiting
 * on this one, and confirming sends `force`.
 *
 * `trigger` is the caller's own button, so a card can use an icon and the Task page a labelled
 * one without this component knowing about either.
 */
export function DeleteTaskAction({
  taskId,
  taskTitle,
  trigger,
  onDeleted,
}: {
  taskId: string;
  taskTitle: string;
  trigger: (open: () => void) => ReactNode;
  onDeleted?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  // Asked for only while the dialog is open: the board renders one of these per card, and a
  // query per card would be a request storm for a number nobody is looking at yet.
  const impact = trpc.task.deletionImpact.useQuery({ id: taskId }, { enabled: open });

  const del = trpc.task.delete.useMutation({
    onSuccess: () => {
      // `onDeleted` first, invalidation second. On the Task page this callback navigates away;
      // invalidating while that page is still mounted makes it refetch the Task it is showing,
      // which has just been deleted — a 404 round trip on every delete, for a view about to
      // unmount. Navigating first lets it go before the refetch is triggered.
      onDeleted?.();
      utils.task.invalidate();
      utils.issue.list.invalidate();
      utils.session.invalidate();
    },
  });

  return (
    <>
      {trigger(() => {
        del.reset();
        setOpen(true);
      })}

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete "${taskTitle}"?`}
        description={describe(impact.data)}
        confirmLabel="Delete task"
        // `force` drops the `blocked_by` edges of any Task waiting on this one. The dialog has
        // just said so, so confirming *is* the decision — there is nothing left to ask.
        onConfirm={() => del.mutate({ id: taskId, force: true })}
      />

      {del.error && (
        <p className="w-full text-right text-destructive text-xs" role="alert">
          {taskActionMessage(del.error.message)}
        </p>
      )}
    </>
  );
}

function describe(impact: TaskDeletionImpactDto | undefined): string {
  if (!impact) return "This cannot be undone. Counting what would be deleted…";

  let text = "This cannot be undone.";
  if (impact.sessionCount > 0) {
    const its = impact.sessionCount === 1 ? "its" : "their";
    text += ` It deletes ${plural(impact.sessionCount, "session")} with ${its} logs and review history.`;
  }
  if (impact.running) text += " The running agent will be stopped first.";
  if (impact.dependentCount > 0) {
    text += ` ${plural(impact.dependentCount, "task")} waiting on this one will be unblocked.`;
  }
  if (impact.worktreeCount > 0) {
    text += ` ${plural(impact.worktreeCount, "git worktree")} will be left on disk — remove them yourself if you need the space.`;
  }
  return text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
