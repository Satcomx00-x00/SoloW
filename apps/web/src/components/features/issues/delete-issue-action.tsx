"use client";

import { type IssueDeletionImpactDto, IssueErrorCode } from "@solow/contracts";
import type { ReactNode } from "react";
import { useState } from "react";
import { ConfirmAction, ConfirmDialog } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { trpc } from "@/trpc/react";

/**
 * Delete an Issue, reusing `ConfirmAction` rather than a second confirm dialog (per the
 * instructions — `components/features/confirm-action.tsx` already owns the wording, the
 * `alertdialog` semantics and the keyboard behaviour every destructive action here shares).
 *
 * Two gates, not one. The plain delete refuses while the Issue still has Tasks (spec F01 States
 * & Rules) and says so; only then does the force path appear, and it opens its own confirmation
 * stating what it is about to destroy. Offering force up front would make the ordinary delete
 * indistinguishable from the cascade, which is the mistake the has-Tasks rule exists to prevent.
 *
 * `ISSUE_HAS_TASKS` and its siblings are translated into the rule stated back to the user, not
 * shown as a raw wire code.
 */
export function DeleteIssueAction({
  issueId,
  issueTitle,
  trigger,
  onSuccess,
}: {
  issueId: string;
  issueTitle: string;
  trigger: ReactNode;
  onSuccess?: () => void;
}) {
  const utils = trpc.useUtils();
  const [forceOpen, setForceOpen] = useState(false);

  const del = trpc.issue.delete.useMutation({
    onSuccess: () => {
      // A force delete takes Tasks and sessions with the Issue, so the board and the session
      // lists are stale too — not just the Issue list the plain delete affects.
      utils.issue.list.invalidate();
      // Deleting the last Issue carrying a label retires that label with it.
      utils.issue.labels.invalidate();
      utils.task.invalidate();
      utils.session.invalidate();
      onSuccess?.();
    },
  });

  const code = del.error?.message;
  const hasTasks = code === IssueErrorCode.HasTasks;

  // Only asked for once the plain delete has been refused: before that there is nothing to
  // count, and the query would run on every Issue row the list renders.
  const impact = trpc.issue.deletionImpact.useQuery({ id: issueId }, { enabled: hasTasks });

  return (
    <>
      <ConfirmAction
        trigger={trigger}
        title={`Delete "${issueTitle}"?`}
        description="This cannot be undone. An issue with tasks against it cannot be deleted — move or remove those tasks first."
        confirmLabel="Delete issue"
        onConfirm={() => del.mutate({ id: issueId, force: false })}
      />

      <ConfirmDialog
        open={forceOpen}
        onOpenChange={setForceOpen}
        title={`Force delete "${issueTitle}"?`}
        description={forceDescription(impact.data)}
        confirmLabel="Force delete"
        onConfirm={() => del.mutate({ id: issueId, force: true })}
      />

      {del.error && (
        // `w-full` forces this to its own line inside a `flex-wrap` button row — see
        // issue-detail.tsx, the caller this text is sized for.
        <p className="w-full text-right text-destructive text-xs" role="alert">
          {messageFor(code)}
        </p>
      )}

      {hasTasks && (
        <Button
          className="w-full justify-end text-destructive text-xs"
          onClick={() => setForceOpen(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Delete it and its tasks anyway
        </Button>
      )}
    </>
  );
}

function messageFor(code: string | undefined): string {
  switch (code) {
    case IssueErrorCode.HasTasks:
      return "This issue still has tasks against it — move or remove them first, or force delete it below.";
    case IssueErrorCode.HasRunningTasks:
      return "A task under this issue started running again before it could be deleted. Try again.";
    case IssueErrorCode.StopFailed:
      return "The running tasks could not be stopped, so nothing was deleted. Check the orchestrator is up, then try again.";
    default:
      return code ?? "Delete failed.";
  }
}

/**
 * The confirmation body for the cascade. Worktree directories are named separately from the rows
 * because deleting the rows is all this can do: removing the directories lives in the
 * orchestrator, past the Executor boundary, so the honest thing is to say they stay.
 */
function forceDescription(impact: IssueDeletionImpactDto | undefined): string {
  if (!impact) return "This cannot be undone. Counting what would be deleted…";

  const parts = [plural(impact.taskCount, "task")];
  if (impact.sessionCount > 0) parts.push(plural(impact.sessionCount, "session"));

  let text = `This cannot be undone. It deletes ${parts.join(" and ")}, including their history.`;
  if (impact.runningTaskCount > 0) {
    text += ` ${plural(impact.runningTaskCount, "task")} still running will be stopped first.`;
  }
  if (impact.worktreeCount > 0) {
    text += ` ${plural(impact.worktreeCount, "git worktree")} will be left on disk — remove them yourself if you need the space.`;
  }
  return text;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
