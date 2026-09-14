"use client";

import type { TaskDeletionImpactDto } from "@solow/contracts";
import { TASK_RETENTION_DAYS } from "@solow/core";
import type { ReactNode } from "react";
import { useState } from "react";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { useToast } from "@/components/ui/toast";
import { taskActionMessage } from "@/lib/task-errors";
import { trpc } from "@/trpc/react";

/**
 * Delete a Task, from wherever a Task is shown — the board card and the Task page both mount
 * this, so the wording, the counts and the refusals are identical in both places.
 *
 * **Undo, not "are you sure?".** A delete is a move to History (Decision 0025): the row keeps
 * for `TASK_RETENTION_DAYS` and `task.restore` brings it back whole. With that in place the
 * dialog was asking a question the app already had an answer to, and punishing every delete for
 * the one that was a slip. So the ordinary delete goes on the click, and a toast offers Undo for
 * ten seconds with a ring that says how long — regret gets a second chance and nobody is asked
 * to read a paragraph first.
 *
 * **The dialog stays for what Restore cannot undo.** Two consequences are not a row in History:
 * a running harness is stopped, and the Tasks waiting on this one are unblocked — and stay
 * unblocked after a restore. Those are named before the click, in the same words as before,
 * because a person deciding whether to walk away needs them at the moment of deciding. The
 * impact is asked for on the click, not on mount — one of these per card on the board, and a
 * query per card would be a request storm for a number nobody is looking at yet.
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
  /** The caller's button; `busy` is true from the press until the delete or the dialog. */
  trigger: (open: () => void, busy: boolean) => ReactNode;
  onDeleted?: () => void;
}) {
  // "Pressed": the impact is being read to decide whether a dialog is owed at all. Exposed on
  // the trigger's wrapper so a caller's button can show it as busy.
  const [deciding, setDeciding] = useState(false);
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const { toast } = useToast();

  // Never on its own: read once per press, below, and the dialog reads the answer from the cache.
  const impact = trpc.task.deletionImpact.useQuery({ id: taskId }, { enabled: false });

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
      toast({
        tone: "ok",
        title: `Deleted "${taskTitle}"`,
        description: `In History for ${TASK_RETENTION_DAYS} days, restorable from there too.`,
        duration: 10_000,
        action: {
          label: "Undo",
          onClick: () => {
            void utils.client.task.restore.mutate({ id: taskId }).then(() => {
              utils.task.invalidate();
              utils.issue.list.invalidate();
              utils.history.list.invalidate();
            });
          },
        },
      });
    },
    onError: (error) => {
      toast({
        tone: "error",
        title: "Nothing was deleted",
        description: taskActionMessage(error.message) ?? error.message,
      });
    },
  });

  /**
   * The press. A fresh read of the impact, not the cached one — a harness may have started since
   * the last look — then: ask when Restore could not undo it, otherwise go. A read that fails
   * opens the dialog anyway, so the delete is never refused for want of a count.
   */
  const press = async () => {
    del.reset();
    setDeciding(true);
    const { data } = await impact.refetch();
    setDeciding(false);
    if (data && !needsAsking(data)) del.mutate({ id: taskId, force: true });
    else setOpen(true);
  };

  return (
    <>
      {trigger(() => void press(), deciding || del.isPending)}

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
    </>
  );
}

/** Whether the delete has a consequence Restore would not reverse. */
function needsAsking(impact: TaskDeletionImpactDto): boolean {
  return impact.running || impact.dependentCount > 0;
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
