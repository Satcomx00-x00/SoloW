"use client";

import type { ReviewDecision, TaskDependencyDto, TaskDto } from "@solow/contracts";
import { canOpenReview } from "@solow/core";
import {
  Check,
  CheckCircle2,
  CircleDashed,
  KeyRound,
  Loader2,
  Play,
  RotateCcw,
  ShieldQuestion,
  X,
} from "lucide-react";
import Link from "next/link";
import { createContext, type ReactNode, useContext, useEffect, useId, useRef } from "react";
import { waitingOn } from "@/components/features/board/blockers";
import { ConfirmAction } from "@/components/features/confirm-action";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
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
/**
 * `bar` is the strip along the foot of a page: sentence left, actions right. `stack` is the
 * same content as a card in a column — sentence, then actions — for the Task page's rail,
 * where the decision sits beside the evidence rather than under it.
 */
type FooterLayout = "bar" | "stack";
const FooterLayoutContext = createContext<FooterLayout>("bar");

export function TaskFooter({
  task,
  layout = "bar",
  outstanding = [],
  consequences,
  viewed = null,
  openItems = [],
  decisionsPending = 0,
  decisionsToApply = 0,
  waiting = null,
  notes = null,
  decidePending,
  decisionSent = null,
  onDecide,
  onSettleDecisions,
  onLaunch,
  onRetry,
  onOpenReview,
  onReopen,
  nextStepName = null,
  criteria = null,
  onOpenChanges,
  onOpenBrief,
  openReviewPending = false,
  actionPending = false,
  renewHref,
  error,
  onDismissError,
}: {
  task: TaskDto;
  layout?: FooterLayout;
  /** Predecessors not yet Done — Launch is refused with these named, as the board refuses it. */
  outstanding?: readonly TaskDependencyDto[];
  /** What one Approve covers, already in words: "2 repositories, 2 branches, 14 files". */
  consequences: string;
  /** How much of the change the reviewer has ticked off — never a gate, only a reminder. */
  viewed?: { viewed: number; of: number } | null;
  /** What the harness said it did not do — listed above the decision, never a lock. */
  openItems?: ReadonlyArray<{ label: string; why: string | null }>;
  /** Decisions the harness emitted that the reviewer has not settled on the board — a lock. */
  decisionsPending?: number;
  /**
   * Decisions the gate is about, settled or not. On a Workflow, approving with any sends the
   * answers back to this Step's harness, which applies them before the Workflow moves on — so
   * Approve says that rather than promising the next Step straight away.
   */
  decisionsToApply?: number;
  /** A checkpoint or permission the running harness is stopped on, until a person answers. */
  waiting?: { requestId: string; title: string } | null;
  /** The notes drafted so far and the general remark, which "Request changes" sends. */
  notes?: { count: number; general: string; onGeneral: (text: string) => void } | null;
  /** The decision in flight, so its button spins and the other two lock (no double-approve). */
  decidePending: ReviewDecision | null;
  /**
   * A decision this page sent and the Task has not yet moved on from. The gate holds on it rather
   * than offering the same buttons again: an approval is applied by the run, seconds later, and a
   * gate that looked untouched in between was clicked twenty-five times on a real Task.
   */
  decisionSent?: ReviewDecision | null;
  onDecide: (decision: ReviewDecision) => void;
  /** Approve pressed with decisions unsettled: take the reviewer to the first one. */
  onSettleDecisions?: (() => void) | undefined;
  onLaunch: () => void;
  onRetry: () => void;
  /** Open the gate on a run that has declared itself finished (`canOpenReview`). */
  onOpenReview: () => void;
  /** Take a Done Task back to Ready (history: resume it from there). */
  onReopen: () => void;
  /** The Workflow Step an approval moves on to, or null when approving finishes the Task. */
  nextStepName?: string | null;
  /** Acceptance criteria the reviewer has verified, when the Issue lists any. */
  criteria?: { verified: number; of: number } | null;
  /** Take the reviewer to the change, or to the brief — the evidence the gate is decided on. */
  onOpenChanges?: (() => void) | undefined;
  onOpenBrief?: (() => void) | undefined;
  openReviewPending?: boolean;
  /** A launch, retry or move in flight. */
  actionPending?: boolean;
  /** Where "Renew" goes for a credential-expired Task; null when the credential is unknown. */
  renewHref: string | null;
  /** A refusal, already mapped to words — never a wire code. */
  error: string | null;
  /** Clears the refusal; without it the line would sit until the next attempt. */
  onDismissError?: (() => void) | undefined;
}) {
  const inReview = task.state === "review";
  const body = footerBody({
    task,
    outstanding,
    consequences,
    viewed,
    openItems,
    decisionsPending,
    decisionsToApply,
    waiting,
    notes,
    decidePending,
    decisionSent,
    onDecide,
    onSettleDecisions,
    onLaunch,
    onRetry,
    onOpenReview,
    onReopen,
    nextStepName,
    criteria,
    onOpenChanges,
    onOpenBrief,
    openReviewPending,
    actionPending,
    renewHref,
  });
  if (body === null && !error) return null;

  return (
    <FooterLayoutContext.Provider value={layout}>
      <div
        data-task-footer={task.state}
        data-layout={layout}
        className={cn(
          "border-t px-4 py-3 transition-colors",
          // The gate lights up only when it is actually your turn.
          inReview && "border-state-review/25 bg-state-review/[0.045]",
        )}
      >
        {body}
        {error ? (
          // The feedback family's red, not the destructive one — Reject spends that, and an error
          // in the same red made every refusal look like a discard. Closable, so it does not sit
          // under the next attempt.
          <p
            className="mt-2 flex items-center gap-2 text-feedback-error text-sm"
            role="alert"
            data-footer-error
          >
            <span className="min-w-0 flex-1">{error}</span>
            {onDismissError ? (
              <Button
                aria-label="Dismiss"
                size="icon-xs"
                variant="ghost"
                className="text-feedback-error hover:text-feedback-error"
                onClick={onDismissError}
              >
                <X />
              </Button>
            ) : null}
          </p>
        ) : null}
      </div>
    </FooterLayoutContext.Provider>
  );
}

type FooterInput = Omit<Parameters<typeof TaskFooter>[0], "error"> & {
  outstanding: readonly TaskDependencyDto[];
  openItems: ReadonlyArray<{ label: string; why: string | null }>;
  decisionsPending: number;
  decisionsToApply: number;
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
              // The harness's own summary is the most useful sentence on the page; it used to
              // be in the button's `title`, which is a tooltip nobody hovers a primary button for.
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-state-done" />
                  {task.completedOutcome === "changes_ready"
                    ? "Finished — changes ready. Open the review to decide on them."
                    : "Finished — the plan is ready and nothing changed. Open the review to approve this step and move the workflow on."}
                </span>
                {task.completedSummary ? (
                  <span className="truncate pl-5 text-xs" title={task.completedSummary}>
                    {task.completedSummary}
                  </span>
                ) : null}
              </span>
            }
          >
            <Button size="lg" loading={input.openReviewPending} onClick={input.onOpenReview}>
              <CheckCircle2 /> Open review
            </Button>
          </Row>
        );
      }
      if (task.completedAt !== null) {
        return (
          <p className="text-muted-foreground text-sm">
            {task.completedOutcome === "blocked"
              ? "The harness stopped — blocked. Steer it from the terminal, or retry once it fails."
              : "Finished — nothing to do. There is nothing to review."}
          </p>
        );
      }
      return (
        <p className="text-muted-foreground text-sm">
          The harness is working. Steer it, or stop it, from the terminal.
        </p>
      );
    case "done":
      // Reopen (history): back to Ready, from where a launch resumes the conversation in the
      // worktree retention kept. Two decisions — reopen, then launch — because starting a harness
      // is never a side effect of reading a finished Task.
      return <Finished {...input} />;
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
  const stacked = useContext(FooterLayoutContext) === "stack";
  return (
    <div
      className={cn(
        stacked
          ? "flex flex-col items-stretch gap-3"
          : "flex flex-wrap items-center justify-between gap-3",
      )}
    >
      <div className="min-w-0 text-muted-foreground text-sm">{hint}</div>
      <div
        className={cn("flex flex-wrap items-center gap-2", stacked ? "justify-end" : "shrink-0")}
      >
        {children}
      </div>
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
  task,
  consequences,
  viewed,
  openItems,
  decisionsPending,
  decisionsToApply,
  notes,
  decidePending,
  decisionSent,
  onDecide,
  onSettleDecisions,
  nextStepName,
  criteria,
  onOpenChanges,
  onOpenBrief,
}: FooterInput) {
  /*
   * Read top to bottom, the way the decision is made: what the harness says it did, what is left
   * to check before trusting that, and then the three choices — each saying, in a sentence, what
   * it will do. The version before this put a counter in the Approve button, a file count in a
   * chip, the scope of the approval in a sentence of numbers and the note box between them, and
   * a reviewer could not tell from it what they were being asked or what any button would do.
   *
   * A decision the harness emitted and nobody settled is the one thing that stands between the
   * reviewer and Approve: the plan it belongs to is what the next Step is briefed with. The
   * button stays live, though — pressing it opens those decisions.
   */
  const canDecide = decidePending === null && !decisionSent;
  const blockedByDecisions = decisionsPending > 0;
  const noteId = useId();
  const open = openItems.length;
  const noteCount = notes?.count ?? 0;
  const unread = viewed ? viewed.of - viewed.viewed : 0;
  return (
    <div className="space-y-5">
      {task.completedSummary ? (
        <section aria-label="What the harness did" className="space-y-1.5">
          <GateHeading>What the harness says it did</GateHeading>
          <p className="rounded-lg border-l-2 border-muted-foreground/30 bg-muted/40 px-3 py-2 text-sm leading-relaxed">
            {task.completedSummary}
          </p>
        </section>
      ) : null}

      <section aria-label="Before you decide" className="space-y-1.5">
        <GateHeading>Before you decide</GateHeading>
        <ul className="divide-y rounded-lg border">
          {viewed ? (
            <CheckRow
              done={unread === 0}
              action={
                onOpenChanges ? { label: "Review the changes", onClick: onOpenChanges } : null
              }
            >
              {unread === 0
                ? `You have looked at all ${viewed.of} changed files.`
                : `You have looked at ${viewed.viewed} of the ${viewed.of} changed files.`}
            </CheckRow>
          ) : null}
          {criteria && criteria.of > 0 ? (
            <CheckRow
              done={criteria.verified === criteria.of}
              action={onOpenBrief ? { label: "Open the brief", onClick: onOpenBrief } : null}
            >
              You have verified {criteria.verified} of the {criteria.of} acceptance criteria.
            </CheckRow>
          ) : null}
          {decisionsPending > 0 ? (
            <CheckRow
              done={false}
              id="task-footer-decisions"
              role="status"
              action={
                onSettleDecisions ? { label: "Answer them", onClick: onSettleDecisions } : null
              }
            >
              {decisionsPending === 1
                ? "1 decision the harness made is waiting for your answer."
                : `${decisionsPending} decisions the harness made are waiting for your answer.`}{" "}
              Approve opens them first.
            </CheckRow>
          ) : null}
          {open > 0 ? (
            /*
              What the harness said it did not do (point 5 of the review analysis). Never a lock —
              a person may still approve — but impossible to not see.
            */
            <li className="px-3 py-2.5 text-sm" role="status" data-open-items={open}>
              <p className="flex items-start gap-2">
                <CircleDashed
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-feedback-caution"
                />
                <span>
                  The harness left {open === 1 ? "1 thing undone" : `${open} things undone`}
                  <span className="sr-only">
                    {" "}
                    ({open === 1 ? "1 open item" : `${open} open items`})
                  </span>
                  :
                </span>
              </p>
              <ul className="mt-1.5 space-y-1 pl-6">
                {openItems.map((item) => (
                  <li key={item.label} className="list-disc text-muted-foreground">
                    <span className="font-medium text-foreground">{item.label}</span>
                    {item.why ? <> — {item.why}</> : null}
                  </li>
                ))}
              </ul>
            </li>
          ) : null}
          {!viewed && !(criteria && criteria.of > 0) && decisionsPending === 0 && open === 0 ? (
            <CheckRow done action={null}>
              Nothing is flagged. The harness reports no open items.
            </CheckRow>
          ) : null}
        </ul>
      </section>

      <section aria-label="Your decision" className="space-y-1.5">
        <GateHeading>Your decision</GateHeading>
        {decisionSent ? (
          <p
            role="status"
            data-decision-sent={decisionSent}
            className="flex items-center gap-2 rounded-lg border border-state-review/40 bg-state-review/[0.06] px-3 py-2 text-sm"
          >
            <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-state-review" />
            {SENT_WORDS[decisionSent]} The run applies it in a few seconds. If nothing changes, this
            page will say so.
          </p>
        ) : null}
        <div className="divide-y rounded-lg border">
          <Choice
            title="Approve"
            explanation={
              <>
                Keep this work. Approving covers {consequences}
                {nextStepName && decisionsToApply > 0
                  ? `. The harness first applies your ${decisionsToApply === 1 ? "answer" : "answers"} to this step, then the workflow moves on to its next step, ${nextStepName}.`
                  : nextStepName
                    ? `, and the workflow moves on to its next step, ${nextStepName}.`
                    : ", and the task is done."}
                {open > 0
                  ? decisionsToApply > 0
                    ? " What is left undone goes back with your answers, for the harness to settle."
                    : " The things left undone stay undone."
                  : ""}
              </>
            }
          >
            <Button
              disabled={!canDecide}
              aria-describedby={blockedByDecisions ? "task-footer-decisions" : undefined}
              loading={decidePending === "approve"}
              onClick={() =>
                blockedByDecisions && onSettleDecisions ? onSettleDecisions() : onDecide("approve")
              }
            >
              <Check />{" "}
              {open > 0 ? `Approve with ${open} open ${open === 1 ? "item" : "items"}` : "Approve"}
            </Button>
          </Choice>
          <Choice
            title="Request changes"
            explanation="Send the harness back to work on this step, with your note and any notes you left on lines of the change."
          >
            <div className="flex w-full flex-col gap-2">
              {notes ? (
                // Never required — the button was once refused without it, which made "request
                // changes" the one decision that could not be taken by pressing it.
                <div className="space-y-1">
                  <label htmlFor={noteId} className="block text-muted-foreground text-xs">
                    Note to the harness (optional)
                  </label>
                  <Textarea
                    id={noteId}
                    rows={2}
                    value={notes.general}
                    onChange={(e) => notes.onGeneral(e.target.value)}
                    placeholder="e.g. Pin the package versions you updated, and run the tests."
                    className="min-h-9 text-sm"
                  />
                </div>
              ) : null}
              <div className="flex items-center justify-end gap-2">
                {noteCount > 0 ? (
                  <span className="text-muted-foreground text-xs">
                    {noteCount === 1 ? "1 note" : `${noteCount} notes`} on lines will be sent
                  </span>
                ) : null}
                <Button
                  variant="outline"
                  disabled={!canDecide}
                  loading={decidePending === "request_changes"}
                  onClick={() => onDecide("request_changes")}
                >
                  <RotateCcw /> Request changes
                </Button>
              </div>
            </div>
          </Choice>
          <Choice
            title="Reject"
            explanation="Throw this work away. Nothing is committed and the task goes back to Ready, to be run again from scratch."
          >
            <ConfirmAction
              disabled={!canDecide}
              title="Reject these changes?"
              description="The harness's work is discarded and the worktree is torn down. This cannot be undone. The task returns to Ready and would have to run again from scratch."
              confirmLabel="Discard the changes"
              onConfirm={() => onDecide("reject")}
              trigger={
                <Button
                  variant="ghost"
                  disabled={!canDecide}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <X /> Reject
                </Button>
              }
            />
          </Choice>
        </div>
      </section>
    </div>
  );
}

const SENT_WORDS: Record<ReviewDecision, string> = {
  approve: "Approved.",
  request_changes: "Changes requested.",
  reject: "Rejected.",
};

function GateHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="font-medium text-2xs text-muted-foreground uppercase tracking-[0.14em]">
      {children}
    </h3>
  );
}

/** One thing to check before deciding: done or not, said in a sentence, with the way to it. */
function CheckRow({
  done,
  action,
  children,
  ...rest
}: {
  done: boolean;
  action: { label: string; onClick: () => void } | null;
  children: ReactNode;
  id?: string;
  role?: string;
}) {
  return (
    <li className="flex items-center gap-2 px-3 py-2.5 text-sm" {...rest}>
      {done ? (
        <CheckCircle2 aria-hidden className="size-4 shrink-0 text-feedback-ok" />
      ) : (
        <CircleDashed aria-hidden className="size-4 shrink-0 text-feedback-caution" />
      )}
      <span className="min-w-0 flex-1">{children}</span>
      {action ? (
        <Button size="xs" variant="link" className="shrink-0" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
    </li>
  );
}

/** One of the three choices: what it is, what it will do, and the button that does it. */
function Choice({
  title,
  explanation,
  children,
}: {
  title: string;
  explanation: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-sm">{title}</p>
        <p className="text-muted-foreground text-xs leading-relaxed">{explanation}</p>
      </div>
      <div className="flex shrink-0 sm:min-w-[12rem] sm:justify-end">{children}</div>
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
  const { toast } = useToast();
  // The button stays live and refuses out loud. Disabled, it left the tab order and its tooltip
  // hung off a wrapper because the control itself fired no events; a press that answers with
  // the blocker's name reaches everyone, and the sentence beside it says the same thing at rest.
  return (
    <Row
      hint={
        blocked
          ? waitingOn(outstanding)
          : "Ready to run. Launching starts a harness in a fresh worktree."
      }
    >
      <Button
        size="lg"
        loading={actionPending}
        aria-disabled={blocked || undefined}
        className={cn(blocked && "opacity-60")}
        onClick={
          blocked
            ? () =>
                toast({ tone: "caution", title: "Not yet", description: waitingOn(outstanding) })
            : onLaunch
        }
      >
        <Play /> Launch
      </Button>
    </Row>
  );
}

/**
 * The end of the flow, which is the part people remember.
 *
 * "Done. Reopen it to work on it again." in grey was a flat last screen for a review that
 * approved and committed a change; it now says what happened — the harness's own summary, or
 * what the approval covered — in the done colour. And the line takes the focus when the Task
 * arrives here: the buttons the reviewer just pressed are gone, and focus that fell to the body
 * left a keyboard or screen-reader user with no word that anything had happened.
 */
function Finished({ task, consequences, actionPending, onReopen }: FooterInput) {
  const status = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    status.current?.focus({ preventScroll: true });
  }, []);
  return (
    <Row
      hint={
        <p
          ref={status}
          tabIndex={-1}
          className="flex min-w-0 items-center gap-1.5 outline-none"
          data-task-finished
        >
          <CheckCircle2 aria-hidden className="size-3.5 shrink-0 text-state-done" />
          <span className="min-w-0 truncate">
            <span className="font-medium text-foreground">Done</span>
            {" — "}
            {/* The harness's report; failing that, the scope of what was reviewed here. Not
                "committed" — Done can also be reached by moving past the gate. */}
            {task.completedSummary ?? `The review covered ${consequences}`}
          </span>
        </p>
      }
    >
      <Button size="lg" variant="outline" loading={actionPending} onClick={onReopen}>
        <RotateCcw /> Reopen
      </Button>
    </Row>
  );
}
