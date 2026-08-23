"use client";

import { type IssueDto, IssueErrorCode, type IssueStatus } from "@gatecontrol/contracts";
import { Check, ChevronDown, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_STYLE, ISSUE_STATUSES } from "@/lib/issue-status";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The Issue's status, and the one control that lets a person disagree with it (spec F01 FR-7).
 *
 * An Issue's status is normally derived from its Tasks, which is right nearly always and wrong
 * in the cases that matter most: work finished outside GateControl, an Issue abandoned with
 * Tasks still on the board, a duplicate. So the badge is a menu, setting an override the DAL
 * records with who and when — and the override is shown *as* an override, with what the Tasks
 * say underneath it, because a status nobody can explain is worse than one nobody can change.
 *
 * Closing is the one status that can strand work, so `setStatus` refuses it while Tasks are
 * still active (FR-9). The refusal arrives here as `IssueErrorCode.HasActiveTasks` and turns
 * into a warning that states the count and offers to do it anyway — the second ask being the
 * whole point.
 */
export function IssueStatusControl({ issue }: { issue: IssueDto }) {
  const utils = trpc.useUtils();
  /** Set once a close is refused: what the user asked for, waiting to be confirmed or dropped. */
  const [blockedClose, setBlockedClose] = useState(false);

  const setStatus = trpc.issue.setStatus.useMutation({
    onSuccess: () => {
      setBlockedClose(false);
      utils.issue.get.invalidate({ id: issue.id });
      utils.issue.list.invalidate();
    },
    onError: (error) => setBlockedClose(error.message === IssueErrorCode.HasActiveTasks),
  });

  const apply = (status: IssueStatus | null, force = false) =>
    setStatus.mutate({ id: issue.id, status, force });

  const { icon: Icon, text, badge } = ISSUE_STATUS_STYLE[issue.status];
  const overridden = issue.statusOverride !== null;
  const derived = ISSUE_STATUS_LABELS[issue.derivedStatus];

  return (
    <div className="space-y-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={setStatus.isPending}
            aria-label={`Status: ${ISSUE_STATUS_LABELS[issue.status]}. Change it`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-2xs transition-opacity duration-100 hover:opacity-80 disabled:opacity-45",
              badge,
            )}
          >
            <Icon aria-hidden strokeWidth={2.25} className={cn("size-3", text)} />
            {ISSUE_STATUS_LABELS[issue.status]}
            <ChevronDown aria-hidden className="size-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuLabel>Set status</DropdownMenuLabel>
          {ISSUE_STATUSES.map((status) => (
            <DropdownMenuItem key={status} onSelect={() => apply(status)}>
              {ISSUE_STATUS_LABELS[status]}
              {issue.statusOverride === status && (
                <Check aria-hidden className="ml-auto size-3.5 text-foreground" />
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {/* Clearing has to be as reachable as setting, or the derived status becomes a
              one-way door: override once and the Tasks never speak again. */}
          <DropdownMenuItem disabled={!overridden} onSelect={() => apply(null)}>
            <RotateCcw aria-hidden />
            Follow tasks ({derived})
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {overridden && (
        <p className="text-2xs text-muted-foreground">
          Set by hand
          {issue.statusOverrideAt && (
            <> on {new Date(issue.statusOverrideAt).toLocaleDateString()}</>
          )}
          {issue.derivedStatus !== issue.status && <> · its tasks read {derived}</>}
        </p>
      )}

      {blockedClose && (
        <div
          className="max-w-md space-y-2 rounded-lg border border-state-failed/30 bg-state-failed/5 p-2.5"
          role="alert"
        >
          <p className="flex items-start gap-2 text-xs leading-relaxed">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-state-failed" aria-hidden />
            <span>
              {issue.activeTaskCount === 1
                ? "1 task under this issue is still active."
                : `${issue.activeTaskCount} tasks under this issue are still active.`}{" "}
              Closing it leaves them running on the board.
            </span>
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              variant="destructive"
              loading={setStatus.isPending}
              onClick={() => apply("closed", true)}
            >
              Close anyway
            </Button>
            {/* `reset()` and not just hiding the warning: the refusal is still the mutation's
                error, and leaving it there would swap the warning for a raw
                ISSUE_HAS_ACTIVE_TASKS the moment this closes. */}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                setBlockedClose(false);
                setStatus.reset();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {setStatus.error && !blockedClose && (
        <p className="font-mono text-2xs text-state-failed" role="alert">
          {setStatus.error.message}
        </p>
      )}
    </div>
  );
}
