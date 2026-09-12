"use client";

import type { ReviewDecision, TaskDependencyDto, TaskDto } from "@solow/contracts";
import { canOpenReview } from "@solow/core";
import {
  Check,
  CheckCircle2,
  CircleDashed,
  GitBranch,
  KeyRound,
  Play,
  RotateCcw,
  Scale,
  ShieldQuestion,
  X,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { waitingOn } from "@/components/features/board/blockers";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CREDENTIAL_EXPIRED_REASON,
  failureReasonLabel,
  STATE_STYLE,
  STRANDED_REVIEW_REASON,
} from "@/lib/task-states";
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
  openItems = [],
  decisionsPending = 0,
  waiting = null,
  notes = null,
  decidePending,
  onDecide,
  onLaunch,
  onRetry,
  onOpenReview,
  onReopen,
  openReviewPending = false,
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
  /** What the harness said it did not do — listed above the decision, never a lock. */
  openItems?: ReadonlyArray<{ label: string; why: string | null }>;
  /** Decisions the harness emitted that the reviewer has not settled on the Plan tab — a lock. */
  decisionsPending?: number;
  /** A checkpoint or permission the running harness is stopped on, until a person answers. */
  waiting?: { requestId: string; title: string } | null;
  /** The notes drafted so far and the general remark, which "Request changes" sends. */
  notes?: { count: number; general: string; onGeneral: (text: string) => void } | null;
  /** The decision in flight, so its button spins and the other two lock (no double-approve). */
  decidePending: ReviewDecision | null;
  onDecide: (decision: ReviewDecision) => void;
  onLaunch: () => void;
  onRetry: () => void;
  /** Open the gate on a run that has declared itself finished (`canOpenReview`). */
  onOpenReview: () => void;
  /** Take a Done Task back to Ready (history: resume it from there). */
  onReopen: () => void;
  openReviewPending?: boolean;
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
    openItems,
    decisionsPending,
    waiting,
    notes,
    decidePending,
    onDecide,
    onLaunch,
    onRetry,
    onOpenReview,
    onReopen,
    openReviewPending,
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
  openItems: ReadonlyArray<{ label: string; why: string | null }>;
  decisionsPending: number;
  actionPending: boolean;
  openReviewPending: boolean;
};

function footerBody(input: FooterInput) {
  const { task } = input;
  switch (task.state) {
    case "review":
      // A decision that was recorded and never applied (the run holding the gate was gone):
      // another decision would go the same way, so the gate gives way to the one control that
      // helps — Retry re-runs the Step, and the run that retries is the one that owns the work.
      if (task.failureReason === STRANDED_REVIEW_REASON) return <FailedOrParked {...input} />;
      return <ReviewGate {...input} />;
    case "failed":
    case "parked":
      return <FailedOrParked {...input} />;
    case "ready":
      return <ReadyToLaunch {...input} />;
    case "backlog":
      // No button: the header's forward arrow is already "Move to Ready", and a second control
      // of the same name on one page is what the control checks — rightly — refuse to click.
      return (
        <p className="text-muted-foreground text-sm">
          This task is in the backlog. Move it to Ready, from the arrow beside its state, when it
          can be worked on.
        </p>
      );
    case "running":
      // A checkpoint (review analysis, point 4) or a permission the harness is stopped on comes
      // before anything else: the run is going nowhere until a person answers, and the card that
      // answers is in the transcript — which may be scrolled away from. Said here, with the way
      // there; never answered here, so there is one control of each name on the page.
      if (input.waiting) {
        return (
          <Row
            hint={
              <span className="flex items-center gap-1.5 text-state-review" role="status">
                <ShieldQuestion aria-hidden className="size-3.5 shrink-0" />
                The harness is waiting for you: {input.waiting.title}
              </span>
            }
          >
            <Button size="lg" onClick={() => revealPermission(input.waiting?.requestId ?? "")}>
              <ShieldQuestion /> Go to the question
            </Button>
          </Row>
        );
      }
      // The harness declared it was finished: the control that opens the gate sits here, with
      // the sentence that says what the gate is about — on a Workflow Step the Step's outcome (a
      // plan), otherwise the change. It used to be a small button in the header, and the person
      // looking for the decision looked here, read a sentence about a button, and did not find
      // it. One "Open review" on the page (the control checks find it by name), and it is this.
      if (canOpenReview(task)) {
        return (
          <Row
            hint={
              <span className="flex items-center gap-1.5">
                <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-state-done" />
                {task.completedOutcome === "changes_ready"
                  ? "Finished — changes ready. Open the review to decide on them."
                  : "Finished — the plan is ready and nothing changed. Open the review to approve this step and move the workflow on."}
              </span>
            }
          >
            <Button
              size="lg"
              loading={input.openReviewPending}
              onClick={input.onOpenReview}
              title={task.completedSummary ?? undefined}
            >
              <CheckCircle2 /> Open review
            </Button>
          </Row>
        );
      }
      if (task.completedAt !== null) {
        return (
          <p className="text-muted-foreground text-sm">
            {task.completedOutcome === "blocked"
              ? "The harness stopped — blocked. Steer it from the box under the terminal, or retry once it fails."
              : "Finished — nothing to do. There is nothing to review."}
          </p>
        );
      }
      return (
        <p className="text-muted-foreground text-sm">
          The harness is working. Steer it, or stop it, from the box under the terminal.
        </p>
      );
    case "done":
      // Reopen (history): back to Ready, from where a launch resumes the conversation in the
      // worktree retention kept. Two decisions — reopen, then launch — because starting a harness
      // is never a side effect of reading a finished Task.
      return (
        <Row
          hint={
            <span className="flex min-w-0 items-center gap-1.5">
              <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-state-done" />
              <span className="truncate">
                {task.completedSummary ?? "Done. Reopen it to work on it again."}
              </span>
            </span>
          }
        >
          <Button
            size="lg"
            variant="outline"
            loading={input.actionPending}
            onClick={input.onReopen}
          >
            <RotateCcw /> Reopen
          </Button>
        </Row>
      );
    default:
      return null;
  }
}

/** A sentence of context on the left, the actions that answer it on the right. */
/** Bring the transcript's card for a request into view and hand it the focus. */
function revealPermission(requestId: string): void {
  if (typeof document === "undefined") return;
  const card = document.querySelector<HTMLElement>(`[data-permission="${CSS.escape(requestId)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "center" });
  card.querySelector<HTMLElement>("button")?.focus();
}

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
function ReviewGate({
  consequences,
  viewed,
  openItems,
  decisionsPending,
  notes,
  decidePending,
  onDecide,
}: FooterInput) {
  // A decision the harness emitted and nobody settled is the one thing that locks Approve: the
  // plan it belongs to is what the next Step is briefed with, and approving it unsettled is
  // approving the harness's choice by default — the rubber stamp the Plan tab exists to replace.
  const canDecide = decidePending === null;
  const canApprove = canDecide && decisionsPending === 0;
  const open = openItems.length;
  const noteCount = notes?.count ?? 0;
  const hasFeedback = noteCount > 0 || Boolean(notes?.general.trim());
  // "7/12 viewed" on the button itself, where the eye is when it is about to press it. Never a
  // block: a reviewer who has read the diff whole has no ticks and nothing to answer for.
  const unread = viewed && viewed.viewed < viewed.of;
  return (
    <div className="space-y-2">
      {open > 0 ? (
        /*
          What the harness said it did not do, where the decision is made (point 5 of the review
          analysis). A "changes ready" report with a migration never applied and a test never
          executed used to say so in the last sentence of a paragraph; the gate opened green all
          the same. Never a lock — a person may still approve — but impossible to not see.
        */
        <div
          className="rounded-lg border border-feedback-caution/40 bg-feedback-caution/10 px-3 py-2 text-xs"
          role="status"
          data-open-items={open}
        >
          <p className="flex items-center gap-1.5 font-medium text-feedback-caution">
            <CircleDashed aria-hidden className="size-3.5 shrink-0" />
            {open === 1 ? "1 open item" : `${open} open items`} — the harness left these undone
          </p>
          <ul className="mt-1 space-y-0.5 pl-5">
            {openItems.map((item) => (
              <li key={item.label} className="list-disc">
                <span className="font-medium">{item.label}</span>
                {item.why ? <span className="text-muted-foreground"> — {item.why}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {decisionsPending > 0 ? (
        <p className="flex items-center gap-1.5 text-state-review text-xs" role="status">
          <Scale aria-hidden className="size-3.5 shrink-0" />
          {decisionsPending === 1 ? "1 decision" : `${decisionsPending} decisions`} the harness made
          {decisionsPending === 1 ? " is" : " are"} waiting for you on the Plan tab — settle{" "}
          {decisionsPending === 1 ? "it" : "them"} to approve.
        </p>
      ) : null}
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
      {notes ? (
        // The general remark, right above the button that sends it (F10 FR-7). Line notes are
        // taken in the diff; this is for what is true of the change as a whole. Never required —
        // the button was once refused without it, which made "request changes" the one decision
        // that could not be taken by pressing it.
        <Textarea
          aria-label="Feedback for the harness"
          rows={2}
          value={notes.general}
          onChange={(e) => notes.onGeneral(e.target.value)}
          placeholder="Anything the harness should know before the next round… (optional)"
          className="min-h-9 max-w-2xl text-xs"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="lg"
          disabled={!canApprove}
          loading={decidePending === "approve"}
          onClick={() => onDecide("approve")}
        >
          <Check />{" "}
          {open > 0 ? `Approve with ${open} open ${open === 1 ? "item" : "items"}` : "Approve"}
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
          {noteCount > 0 ? (
            <span aria-hidden className="ml-1 font-mono text-2xs tabular-nums opacity-80">
              {noteCount} {noteCount === 1 ? "note" : "notes"}
            </span>
          ) : null}
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
        {hasFeedback ? (
          // Said here rather than as a confirm on Approve and Reject: the notes are the
          // reviewer's own draft, and losing a draft is not the destructive act a dialog is for.
          <span className="text-2xs text-muted-foreground">
            Notes go with Request changes only.
          </span>
        ) : null}
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
