import type { TaskState } from "@solow/contracts";
import { isLiveState, STATE_LABELS, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";

/**
 * The lifecycle state of a Task, everywhere it is shown.
 *
 * One component rather than a `Badge variant={...}` at each call site, because the mapping from
 * state to appearance is domain knowledge, not styling: it decides whether a reader can tell
 * "an agent is working" from "an agent is waiting for me" at a glance. Keeping it in one place
 * is what stops the two drifting back into looking alike.
 *
 * `data-task-state` stays on the element — the E2E suite reads the Task's state through it.
 */
export function TaskStateBadge({
  state,
  count,
  size = "default",
  className,
}: {
  state: TaskState;
  /** Renders a count instead of the label, for column headers and the lifecycle navigator. */
  count?: number;
  /** `sm` is for dense rows; `default` for headers and the task view. */
  size?: "sm" | "default";
  className?: string;
}) {
  const { icon: Icon, badgeClassName, hint } = STATE_STYLE[state];
  const label = STATE_LABELS[state];

  return (
    <span
      data-task-state={state}
      title={hint}
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-full border font-medium tabular-nums whitespace-nowrap",
        size === "sm" ? "gap-1 px-1.5 py-px text-2xs" : "gap-1.5 px-2 py-0.5 text-xs",
        badgeClassName,
        className,
      )}
    >
      <Icon
        aria-hidden
        strokeWidth={2.25}
        className={cn(
          "shrink-0",
          size === "sm" ? "size-2.5" : "size-3",
          // The ambient cadence: a board can have a dozen of these turning at once.
          isLiveState(state) && "spinner-ambient",
        )}
      />
      {count === undefined ? (
        label
      ) : (
        <>
          <span className="sr-only">{label}: </span>
          <span>{count}</span>
        </>
      )}
    </span>
  );
}
