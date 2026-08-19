import type { TaskDto } from "@gatecontrol/contracts";
import { GitBranch } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { needsAttention, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";

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
 */
export function TaskCard({
  task,
  actions,
  dragHandle,
}: {
  task: TaskDto;
  actions?: ReactNode;
  dragHandle?: ReactNode;
}) {
  const attention = needsAttention(task.state);
  const reference = task.resultBranch ?? task.id.slice(0, 8);

  return (
    <article
      className={cn(
        "group/card surface-edge relative overflow-hidden rounded-lg border bg-card transition-all duration-150",
        "hover:-translate-y-px hover:border-ring/35 hover:shadow-panel",
        attention && "border-state-review/35",
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
        </div>

        {actions ? <div className="mt-2.5 flex gap-1.5">{actions}</div> : null}
      </div>
    </article>
  );
}
