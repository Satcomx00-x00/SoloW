"use client";

import { type IssueDto, IssueErrorCode, type IssueStatus } from "@gatecontrol/contracts";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Pencil,
  RotateCcw,
  SquareArrowOutUpRight,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { IssueFormDialog } from "@/components/features/issues/issue-form-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ISSUE_SOURCE_LABELS,
  ISSUE_STATUS_LABELS,
  ISSUE_STATUS_STYLE,
  ISSUE_STATUSES,
} from "@/lib/issue-status";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The Issue a card's Task came from, and the edits worth making without leaving the board.
 *
 * This replaces a plain `#42` link out to GitHub. The link answered "which Issue is this" and
 * nothing else — every actual change to the Issue meant leaving the board, finding it in the
 * Issues list, and coming back. The number is still the label, because the number is what people
 * call an Issue by; it is now the handle on a menu rather than a one-way door.
 *
 * What the menu offers is deliberately the *quick* set: a status override, which is one click and
 * the edit an Owner makes most from a board; the title/description/labels dialog, which is the
 * same one the Issue page opens; and the two ways out — the Issue's own page, and the provider's.
 * Deleting is not here. It is not a quick edit, it cascades into Tasks, and the card the menu
 * hangs off would be one of the things it destroyed.
 *
 * `stopPropagation` on the trigger for the reason the old link needed it: the card is a link to
 * the Task, and opening this menu must not navigate away from the board underneath it.
 */
export function IssueMenu({ issue }: { issue: IssueDto }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  /** Set when a close is refused over active Tasks — the second ask, which is the point of FR-9. */
  const [blockedClose, setBlockedClose] = useState(false);

  const setStatus = trpc.issue.setStatus.useMutation({
    onSuccess: () => {
      setBlockedClose(false);
      utils.issue.list.invalidate();
      utils.issue.get.invalidate({ id: issue.id });
      // The board's own cards read the Issue's status through `issue.list`, and a Task's state
      // is derived from it nowhere — but the Issues view is one navigation away and stale.
      utils.task.list.invalidate();
    },
    onError: (error) => setBlockedClose(error.message === IssueErrorCode.HasActiveTasks),
  });

  const apply = (status: IssueStatus | null, force = false) =>
    setStatus.mutate({ id: issue.id, status, force });

  const label = issue.externalNumber === null ? "Issue" : `#${issue.externalNumber}`;
  const { icon: StatusIcon, text: statusText } = ISSUE_STATUS_STYLE[issue.status];
  const overridden = issue.statusOverride !== null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={setStatus.isPending}
            onClick={(event) => event.stopPropagation()}
            aria-label={`${label}: ${issue.title}. Edit this issue`}
            title={issue.title}
            className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-45"
          >
            <StatusIcon aria-hidden strokeWidth={2.25} className={cn("size-3", statusText)} />
            {label}
            <ChevronDown aria-hidden className="size-3 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {/* The title first, because the number alone does not say which Issue this is — and on
              a board of thirty cards that is the question the menu is opened to answer. */}
          <DropdownMenuLabel className="line-clamp-2 font-normal text-muted-foreground text-2xs leading-snug">
            {issue.title}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          <DropdownMenuLabel>Set status</DropdownMenuLabel>
          {ISSUE_STATUSES.map((status) => (
            <DropdownMenuItem key={status} onSelect={() => apply(status)}>
              {ISSUE_STATUS_LABELS[status]}
              {issue.status === status && (
                <Check aria-hidden className="ml-auto size-3.5 text-foreground" />
              )}
            </DropdownMenuItem>
          ))}
          {/* Clearing has to be as reachable as setting, or an override is a one-way door: set it
              once and the Issue's Tasks never speak for it again. */}
          <DropdownMenuItem disabled={!overridden} onSelect={() => apply(null)}>
            <RotateCcw aria-hidden />
            Follow tasks ({ISSUE_STATUS_LABELS[issue.derivedStatus]})
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setEditing(true)}>
            <Pencil aria-hidden />
            Edit title and labels…
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/issues/${issue.id}`}>
              <SquareArrowOutUpRight aria-hidden />
              Open the issue
            </Link>
          </DropdownMenuItem>
          {issue.externalUrl && (
            <DropdownMenuItem asChild>
              <a href={issue.externalUrl} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                View on {ISSUE_SOURCE_LABELS[issue.source]}
              </a>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
        Mounted only while it is open. The dialog seeds its fields from the Issue on mount, so one
        kept alive beside every card would hold the values an Issue had when the board first
        painted — and there are as many of these as there are cards.
      */}
      {editing && <IssueFormDialog issue={issue} open onOpenChange={setEditing} />}

      {/*
        Closing an Issue with Tasks still running strands them (spec F01 FR-9). The Issue page
        answers that refusal with a warning panel; a card has no room for one, so the second ask
        is a dialog — same question, same count, same "do it anyway".
      */}
      <ConfirmDialog
        open={blockedClose}
        onOpenChange={(open) => {
          if (!open) {
            setBlockedClose(false);
            // `reset()` and not just closing: the refusal is still the mutation's error, and
            // leaving it there would re-open this on the next render.
            setStatus.reset();
          }
        }}
        title="Close this issue anyway?"
        description={
          issue.activeTaskCount === 1
            ? "1 task under this issue is still active. Closing it leaves that task running on the board."
            : `${issue.activeTaskCount} tasks under this issue are still active. Closing it leaves them running on the board.`
        }
        confirmLabel="Close it anyway"
        onConfirm={() => apply("closed", true)}
      />
    </>
  );
}
