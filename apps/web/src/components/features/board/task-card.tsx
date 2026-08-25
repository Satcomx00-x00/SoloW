import type { TaskDependencyDto, TaskDto } from "@gatecontrol/contracts";
import { primaryTaskRepository, unsatisfiedDependencies } from "@gatecontrol/core";
import { CheckCircle2, GitBranch, KeyRound, Library, Lock, RotateCcw } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CREDENTIAL_EXPIRED_REASON,
  INTERRUPTED_REASON,
  needsAttention,
  STATE_STYLE,
} from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { waitingOn } from "./blockers";
import { useBoardReferences } from "./board-references";
import { IssueMenu } from "./issue-menu";

/**
 * A single Task card on the board.
 *
 * The card does *not* repeat the lifecycle state as a badge: the column it sits in already says
 * that, and a pill on every card would be seven columns of noise. The one exception is Review,
 * which gets a warm edge — it is the only state waiting on a person, and the point of the board
 * is finding those without reading it.
 *
 * `actions` (optional) renders lifecycle controls; `dragHandle` (optional) is the only draggable
 * affordance — the card body stays a plain link so its controls are not nested inside another
 * interactive element.
 *
 * `blockers` (optional, issue #6) are the Task's declared `blocked_by` edges. Whether they still
 * hold is derived from the blockers' states here rather than being asked of the server, so the
 * card stops looking blocked on the same refetch that moves the last predecessor into Done.
 *
 * `ghost` marks the copy the drag overlay renders under the cursor. The card of record is still
 * mounted in its column while a drag is in flight, so the copy carries no `id`: two nodes
 * claiming one id is invalid HTML, and it would make the lock badge's `getElementById` scroll
 * resolve by document order instead of to a determinate card.
 */
export function TaskCard({
  task,
  actions,
  dragHandle,
  blockers,
  ghost,
  onSubmitForReview,
  submitting = false,
}: {
  task: TaskDto;
  actions?: ReactNode;
  dragHandle?: ReactNode;
  blockers?: readonly TaskDependencyDto[] | undefined;
  ghost?: boolean;
  /**
   * Open the review gate on a Task whose agent has declared it finished.
   *
   * Absent on a board that cannot act — the ghost a drag leaves behind, and any read-only view.
   * The control is the *only* way a Task enters review: the run records the declaration and
   * stops, and this click is the one action that opens the gate (Principle I).
   */
  onSubmitForReview?: (taskId: string) => void;
  submitting?: boolean;
}) {
  const attention = needsAttention(task.state);
  const references = useBoardReferences();
  // The primary attachment (issue #7): a Task spanning several Repositories has several branches
  // and the card has room for one, so it names the one the agent is actually started in and says
  // how many others there are beside it.
  const primary = task.repositories.length > 0 ? primaryTaskRepository(task.repositories) : null;
  const repositoryName = primary ? references.repositoryName(primary.repositoryId) : null;
  // `checkoutBranch` as the fallback rather than a slice of the Task id. The id was standing in
  // for a branch under a `GitBranch` glyph, which is a hash dressed as a ref — and the checkout
  // branch exists from the moment the attachment does, where `resultBranch` only appears once a
  // run has produced something.
  const branch = primary?.resultBranch ?? primary?.checkoutBranch ?? null;
  const issue = references.issue(task.issueId);
  const extraRepositories = Math.max(task.repositories.length - 1, 0);
  const outstanding = unsatisfiedDependencies(blockers ?? []);
  const first = outstanding[0];
  /*
   * "The agent says it has finished, and there is something to look at."
   *
   * Both halves matter. `completedAt` alone would also be true of a run that finished having
   * changed nothing (`nothing_to_do`) or one that gave up (`blocked`) — neither has anything to
   * approve, and offering the gate on them asks a person to sign off on nothing. The badge below
   * still reports those, because "finished, nothing to do" is an answer and the card should say
   * it rather than looking like a Task that stalled.
   */
  const declared = task.completedAt !== null;
  const readyForReview = declared && task.completedOutcome === "changes_ready";

  return (
    <article
      // A stable anchor so the lock badge on a blocked card can bring its blocker into view.
      id={ghost ? undefined : `task-${task.id}`}
      className={cn(
        "group/card surface-edge relative overflow-hidden rounded-lg border bg-card transition-all duration-150",
        "hover:-translate-y-px hover:border-ring/35 hover:shadow-panel",
        attention && "border-state-review/35",
        // Dimmed, not hidden: a blocked Task is still work the Owner planned, it just cannot run
        // yet — so it recedes rather than disappearing.
        outstanding.length > 0 && "opacity-65",
      )}
    >
      {/* A hairline down the leading edge, so a Review card is findable from the corner of the eye. */}
      {attention && (
        <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-state-review/70" />
      )}

      <div className="px-3.5 py-3">
        <div className="flex items-start gap-1.5">
          <Link
            href={`/task/${task.id}`}
            className="min-w-0 flex-1 font-medium text-sm leading-snug decoration-muted-foreground/50 underline-offset-2 hover:underline"
          >
            {task.title}
          </Link>
          {dragHandle}
        </div>

        {(outstanding.length > 0 || task.failureReason || declared || extraRepositories > 0) && (
          <div className="mt-2.5 flex items-center gap-1.5">
            {declared ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-px text-2xs",
                  readyForReview
                    ? "border-state-done/30 bg-state-done/10 text-state-done"
                    : "border-border bg-muted/40 text-muted-foreground",
                )}
              >
                <CheckCircle2 className="size-3 shrink-0" aria-hidden />
                {task.completedOutcome === "nothing_to_do"
                  ? "Finished — nothing to do"
                  : task.completedOutcome === "blocked"
                    ? "Stopped — blocked"
                    : "Finished"}
              </span>
            ) : null}
            {outstanding.length > 0 && first ? (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Blocked by ${outstanding.length} task${outstanding.length === 1 ? "" : "s"}`}
                      onClick={() =>
                        document
                          .getElementById(`task-${first.blockedByTaskId}`)
                          ?.scrollIntoView({ behavior: "smooth", block: "center" })
                      }
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-2xs text-muted-foreground hover:text-foreground"
                    >
                      <Lock className="size-3 shrink-0" aria-hidden />
                      {outstanding.length}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{waitingOn(outstanding)}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            {task.failureReason === CREDENTIAL_EXPIRED_REASON ? (
              // Distinguished from a generic failure (spec AC-013, issue #63): the raw class
              // string below is a machine name for a whole family of run failures, but this one
              // has a one-click fix, so it earns its own icon and its own words rather than
              // sharing the plain badge every other failure reason falls into.
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-px text-2xs",
                  STATE_STYLE.failed.badgeClassName,
                )}
              >
                <KeyRound className="size-3 shrink-0" aria-hidden />
                Credential expired
              </span>
            ) : task.failureReason === INTERRUPTED_REASON ? (
              // Same reasoning as credential-expired: a raw "interrupted" would read as just
              // another failure class, but this one means something specific an Owner should not
              // have to infer — the orchestrator restarted mid-run, the work itself is untouched,
              // and Retry (below) picks it back up rather than starting over.
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-px text-2xs",
                  STATE_STYLE.failed.badgeClassName,
                )}
              >
                <RotateCcw className="size-3 shrink-0" aria-hidden />
                Interrupted by restart
              </span>
            ) : task.failureReason ? (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-2xs",
                  STATE_STYLE.failed.badgeClassName,
                )}
              >
                {task.failureReason}
              </span>
            ) : null}
            {extraRepositories > 0 ? (
              <span
                // `img` with a label rather than a bare span: the count is meaningless read as
                // loose text, and a screen reader should hear "3 repositories", not "3".
                role="img"
                aria-label={`${task.repositories.length} repositories`}
                title={`${task.repositories.length} repositories`}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-2xs text-muted-foreground"
              >
                <Library className="size-3 shrink-0" aria-hidden />
                {task.repositories.length}
              </span>
            ) : null}
          </div>
        )}

        {/*
          Where the work is, and what it is for.

          Repository and branch are stacked rather than run together on one line. Side by side
          they had to share about 250px with a separator between them, so on any real name — an
          org-prefixed repository, a branch carrying a Task id — both truncated at once and the
          card told you neither. One per line lets each take the full width and truncate only when
          it genuinely has to, and it puts the two facts in the order you read them: which
          repository, then where in it.

          The Issue sits to the right of both, vertically centred against the pair, because it is
          the one thing here you act on rather than read.
        */}
        {(repositoryName || branch || issue) && (
          <div className="mt-2.5 flex items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-1 font-mono text-2xs text-muted-foreground/80">
              {repositoryName && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <Library className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                  <span className="truncate text-muted-foreground">{repositoryName}</span>
                </span>
              )}
              {branch && (
                <span className="flex min-w-0 items-center gap-1.5">
                  <GitBranch className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                  <span className="truncate">{branch}</span>
                </span>
              )}
            </div>
            {issue && <IssueMenu issue={issue} />}
          </div>
        )}

        {/*
          The one action that opens the review gate.
          
          Green, and only present when the agent has declared `changes_ready` — a Task still
          working, or one that finished with nothing to show, offers nothing to click. The label
          says what will happen rather than naming a column, because "Review" beside a card
          already sitting in a column is ambiguous about which way it goes.
        */}
        {readyForReview && onSubmitForReview ? (
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSubmitForReview(task.id)}
            title={task.completedSummary ?? undefined}
            className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-state-done/35 bg-state-done/12 px-2 py-1.5 font-medium text-2xs text-state-done transition-colors hover:bg-state-done/20 disabled:opacity-50"
          >
            <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
            Open review
          </button>
        ) : null}

        {actions ? <div className="mt-2.5 flex gap-1.5">{actions}</div> : null}
      </div>
    </article>
  );
}
