import type { TaskDependencyDto, TaskDto } from "@gatecontrol/contracts";
import { primaryTaskRepository, unsatisfiedDependencies } from "@gatecontrol/core";
import { GitBranch, Library, Lock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { needsAttention, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { waitingOn } from "./blockers";

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
}: {
  task: TaskDto;
  actions?: ReactNode;
  dragHandle?: ReactNode;
  blockers?: readonly TaskDependencyDto[] | undefined;
  ghost?: boolean;
}) {
  const attention = needsAttention(task.state);
  // The branch the primary attachment's work landed on (issue #7). A Task spanning several
  // Repositories has several result branches, and the card has room for one line — so it shows
  // the one the agent actually ran in, and says how many others there are beside it.
  const primary = task.repositories.length > 0 ? primaryTaskRepository(task.repositories) : null;
  const reference = primary?.resultBranch ?? task.id.slice(0, 8);
  const extraRepositories = Math.max(task.repositories.length - 1, 0);
  const outstanding = unsatisfiedDependencies(blockers ?? []);
  const first = outstanding[0];

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

      <div className="px-3 py-2.5">
        <div className="flex items-start gap-1.5">
          <Link
            href={`/task/${task.id}`}
            className="min-w-0 flex-1 font-medium text-sm leading-snug decoration-muted-foreground/50 underline-offset-2 hover:underline"
          >
            {task.title}
          </Link>
          {dragHandle}
        </div>

        <div className="mt-2 flex items-center gap-1.5">
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
          {task.failureReason ? (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-2xs",
                STATE_STYLE.failed.badgeClassName,
              )}
            >
              {task.failureReason}
            </span>
          ) : (
            <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground/80">
              <GitBranch className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{reference}</span>
            </span>
          )}
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

        {actions ? <div className="mt-2.5 flex gap-1.5">{actions}</div> : null}
      </div>
    </article>
  );
}
