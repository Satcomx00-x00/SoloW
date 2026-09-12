"use client";

import type { TaskDeletionImpactDto } from "@solow/contracts";
import { TASK_RETENTION_DAYS } from "@solow/core";
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
  const window = `${TASK_RETENTION_DAYS} days`;
  if (!impact)
    return `It goes to History for ${window}, restorable. Counting what it takes with it…`;

  let text = `It goes to History for ${window}, where it can be restored or resumed; after that it is gone for good.`;
  if (impact.sessionCount > 0) {
    const its = impact.sessionCount === 1 ? "its" : "their";
    text += ` ${plural(impact.sessionCount, "session")} with ${its} logs and review history go with it.`;
  }
  if (impact.running) text += " The running harness will be stopped first.";
  if (impact.dependentCount > 0) {
    text += ` ${plural(impact.dependentCount, "task")} waiting on this one will be unblocked, and stay unblocked if it is restored.`;
  }
  if (impact.worktreeCount > 0) {
    const stay = impact.worktreeCount === 1 ? "stays" : "stay";
    text += ` ${plural(impact.worktreeCount, "git worktree")} ${stay} on disk for the ${window}, then ${impact.worktreeCount === 1 ? "is" : "are"} removed.`;
  }
  return text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
