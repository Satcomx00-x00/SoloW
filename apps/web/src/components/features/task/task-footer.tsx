"use client";

import type { ReviewDecision, TaskDependencyDto, TaskDto, TaskState } from "@solow/contracts";
import { Check, CheckCircle2, GitBranch, KeyRound, Play, RotateCcw, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { waitingOn } from "@/components/features/board/blockers";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CREDENTIAL_EXPIRED_REASON, failureReasonLabel, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";

/**
 * The strip along the foot of the Task page: what this Task needs from a person right now.
 *
 * It used to be the review gate and nothing else — Approve, Request changes, Reject when the
 * Task was in Review, and otherwise one sentence promising those would appear later. That left
 * every other state with no action on the page that holds the evidence for it: a failed run
 * showed its badge and made the operator go back to the board to find Retry; a Ready Task had
 * only the forward arrow in the header, which does not say "Launch".
 *
 * So the foot now answers per state, in the board's own words and with the board's own rules
 * (`board.tsx` `retryAction` / `renewAction` / `requestLaunch`), because an operator who learned
 * what "Retry" does there should not have to learn it again here. The gate itself is unchanged.
 *
 * Presentational on purpose, like `TaskAdvance`: it takes the Task and hands back intents. The
 * workspace owns every mutation — its invalidations, its pending flags, its error mapping — and
 * a second call site for `task.retry` is a second place for those to be got wrong.
 */
export function TaskFooter({
  task,
  outstanding = [],
  consequences,
  viewed = null,
  decidePending,
  onDecide,
  onLaunch,
  onRetry,
  onMove,
  actionPending = false,
  renewHref,
  error,
}: {
  task: TaskDto;
  /** Predecessors not yet Done — Launch is refused with these named, as the board refuses it. */
  outstanding?: readonly TaskDependencyDto[];
  /** What one Approve covers, already in words: "2 repositories, 2 branches, 14 files". */
  consequences: string;
  /** How much of the change the reviewer has ticked off — never a gate, only a reminder. */
  viewed?: { viewed: number; of: number } | null;
  /** The decision in flight, so its button spins and the other two lock (no double-approve). */
  decidePending: ReviewDecision | null;
  onDecide: (decision: ReviewDecision) => void;
  onLaunch: () => void;
  onRetry: () => void;
  onMove: (to: TaskState) => void;
  /** A launch, retry or move in flight. */
  actionPending?: boolean;
  /** Where "Renew" goes for a credential-expired Task; null when the credential is unknown. */
  renewHref: string | null;
  /** A refusal, already mapped to words — never a wire code. */
  error: string | null;
}) {
  const inReview = task.state === "review";
  const body = footerBody({
    task,
    outstanding,
    consequences,
    viewed,
    decidePending,
    onDecide,
    onLaunch,
    onRetry,
    onMove,
    actionPending,
    renewHref,
  });
  if (body === null && !error) return null;

  return (
    <div
      data-task-footer={task.state}
      className={cn(
        "border-t px-4 py-3 transition-colors",
        // The gate lights up only when it is actually your turn.
        inReview && "border-state-review/25 bg-state-review/[0.045]",
      )}
    >
      {body}
      {error ? (
        <p className="mt-2 text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type FooterInput = Omit<Parameters<typeof TaskFooter>[0], "error"> & {
  outstanding: readonly TaskDependencyDto[];
  actionPending: boolean;
};

function footerBody(input: FooterInput) {
  const { task } = input;
  switch (task.state) {
    case "review":
      return <ReviewGate {...input} />;
    case "failed":
    case "parked":
      return <FailedOrParked {...input} />;
    case "ready":
      return <ReadyToLaunch {...input} />;
    case "backlog":
      return (
        <Row hint="This task is in the backlog. Move it to Ready when it can be worked on.">
          <Button
            size="lg"
            variant="outline"
            loading={input.actionPending}
            onClick={() => input.onMove("ready")}
          >
            Move to Ready
          </Button>
        </Row>
      );
    case "running":
      // The harness declared it was finished and the header carries the one "Open review"
      // control (the control checks expect exactly one on the page). The foot only says so.
      return task.completedOutcome === "changes_ready" ? (
        <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
          <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-state-done" />
          Finished — changes ready. Open review above to decide on them.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          The harness is working. Steer it, or stop it, from the box under the terminal.
        </p>
      );
    case "done":
      return task.completedSummary ? (
        <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
          <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-state-done" />
          <span className="truncate">{task.completedSummary}</span>
        </p>
      ) : null;
    default:
      return null;
  }
}

/** A sentence of context on the left, the actions that answer it on the right. */
function Row({ hint, children }: { hint: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 text-muted-foreground text-sm">{hint}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * The completion gate (Principle I), exactly as it was when it was the whole footer.
 *
 * One decision covers the whole Task — splitting it per repository would look more granular and
 * is worse, because it produces partially-integrated Tasks that nothing in the model describes.
 * So the scope of the single decision has to be legible, and a reviewer who approves without
 * scrolling the Changes column still sees it (issue #70 AC-2/AC-3).
 */
function ReviewGate({ consequences, viewed, decidePending, onDecide }: FooterInput) {
  const canDecide = decidePending === null;
  // "7/12 viewed" on the button itself, where the eye is when it is about to press it. Never a
  // block: a reviewer who has read the diff whole has no ticks and nothing to answer for.
  const unread = viewed && viewed.viewed < viewed.of;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <GitBranch aria-hidden className="size-3.5 shrink-0" />
        <span>
          Approving covers {consequences}.
          {viewed ? (
            <span className={cn("ml-1", unread && "text-feedback-caution")}>
              {viewed.viewed} of {viewed.of} files viewed.
            </span>
          ) : null}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="lg"
          disabled={!canDecide}
          loading={decidePending === "approve"}
          onClick={() => onDecide("approve")}
        >
          <Check /> Approve
          {viewed ? (
            // Decoration on the button; the sentence above carries the same fact in words, so the
            // button's name stays "Approve" for anyone (or any check) that finds it by name.
            <span
              aria-hidden
              className={cn(
                "ml-1 font-mono text-2xs tabular-nums opacity-80",
                unread && "text-feedback-caution",
              )}
            >
              {viewed.viewed}/{viewed.of}
            </span>
          ) : null}
        </Button>
        <Button
          size="lg"
          variant="outline"
          disabled={!canDecide}
          loading={decidePending === "request_changes"}
          onClick={() => onDecide("request_changes")}
        >
          <RotateCcw /> Request changes
        </Button>
        <ConfirmAction
          disabled={!canDecide}
          title="Reject these changes?"
          description="The harness's work is discarded and the worktree is torn down. This cannot be undone. The task returns to Ready and would have to run again from scratch."
          confirmLabel="Discard the changes"
          onConfirm={() => onDecide("reject")}
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
      </div>
    </div>
  );
}

/**
 * A run that stopped, and the one thing that starts it again.
 *
 * Retry for everything except an expired credential, which the board also refuses to retry:
 * trying again before the credential itself changes would only fail the same way again
 * immediately, so that one gets Renew instead (spec AC-013, issue #63). A parked Task resumes by
 * itself when the quota window resets; Retry there is "don't wait".
 */
function FailedOrParked({ task, actionPending, onRetry, renewHref }: FooterInput) {
  const reason = task.failureReason ? failureReasonLabel(task.failureReason) : null;
  const parked = task.state === "parked";
  const tone = reason?.tone ?? task.state;
  const Icon = reason?.icon ?? STATE_STYLE[tone].icon;
  const label = reason?.label ?? (parked ? "Paused on quota" : "Run failed");
  const detail =
    reason?.detail ??
    (parked
      ? "The run resumes by itself when the quota window resets. Retry to start it now instead."
      : "Retry starts a fresh run from the task brief.");
  const renew = task.failureReason === CREDENTIAL_EXPIRED_REASON;

  return (
    <Row
      hint={
        <>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded border px-1.5 py-px font-medium text-2xs",
              STATE_STYLE[tone].badgeClassName,
            )}
          >
            <Icon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
            {label}
            {reason?.code ? <span className="sr-only"> (reason: {reason.code})</span> : null}
          </span>
          <span className="ml-2">{detail}</span>
        </>
      }
    >
      {renew ? (
        <Button asChild size="lg" variant="outline">
          <Link href={renewHref ?? "#"}>
            <KeyRound /> Renew
          </Link>
        </Button>
      ) : (
        <Button size="lg" loading={actionPending} onClick={onRetry}>
          <RotateCcw /> Retry
        </Button>
      )}
    </Row>
  );
}

/**
 * Launch, refused with the blockers named when a predecessor is not Done — the board's rule
 * (`requireUnblocked` on the server, `waitingOn` in the tooltip), so the refusal is a sentence
 * here too rather than a `TASK_BLOCKED` in the banner.
 */
function ReadyToLaunch({ outstanding, actionPending, onLaunch }: FooterInput) {
  const blocked = outstanding.length > 0;
  const button = (
    <Button size="lg" loading={actionPending} disabled={blocked} onClick={onLaunch}>
      <Play /> Launch
    </Button>
  );
  return (
    <Row
      hint={
        blocked
          ? waitingOn(outstanding)
          : "Ready to run. Launching starts a harness in a fresh worktree."
      }
    >
      {blocked ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            {/* A disabled button fires no pointer events, so the tooltip hangs off a wrapper. */}
            <TooltipTrigger asChild>
              <span className="inline-flex">{button}</span>
            </TooltipTrigger>
            <TooltipContent>{waitingOn(outstanding)}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        button
      )}
    </Row>
  );
}
