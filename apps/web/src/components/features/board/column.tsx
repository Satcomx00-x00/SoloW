import type { TaskDependencyDto, TaskDto } from "@solow/contracts";
import type { ReactNode } from "react";
import type { BoardColumn } from "@/lib/board-columns";
import { cn } from "@/lib/utils";
import { TaskCard } from "./task-card";

/**
 * A card's `<li>` is freshly mounted exactly when it (re)appears in a column: on the board's
 * first paint, and whenever a successful move re-renders it into a different column's list
 * (React keys the list by `task.id`, so a card moving columns is a new element in the
 * destination `<ul>`, not a re-positioned one in the source). That is precisely the "a card
 * moves between columns" moment the report asks to see animated — tw-animate-css (imported once
 * in globals.css, already used unconditionally by dialog.tsx/tooltip.tsx/select.tsx) drives it,
 * so no new dependency and no per-component animation wiring.
 *
 * `prefers-reduced-motion` needs nothing further here: globals.css's existing
 * `@media (prefers-reduced-motion: reduce)` block already zeroes every animation/transition
 * duration site-wide.
 */
export const CARD_ENTRANCE_CLASS = "animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out";

/**
 * The head of a column: its own glyph, its name, and how many sit in it.
 *
 * Shared by the plain column and the draggable one so the two cannot drift apart — they are the
 * same column, one of them just also accepts a drop.
 *
 * It takes the whole descriptor rather than a `TaskState` (issue #5 AC-6): the `STATE_STYLE`
 * lookup moved behind `lifecycleColumns()`, so this header no longer knows that lifecycle states
 * exist and can draw a Workflow Step with the same markup it always drew a state with.
 */
export function ColumnHeader({ column, count }: { column: BoardColumn; count: number }) {
  const { icon: Icon, textClassName, barClassName, hint, label } = column;
  return (
    <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2.5">
      <Icon
        aria-hidden
        strokeWidth={2.25}
        className={cn(
          "size-3.5 shrink-0",
          count === 0 ? "text-muted-foreground/40" : textClassName,
        )}
      />
      <span
        title={hint}
        className={cn(
          "font-medium text-2xs uppercase tracking-[0.12em]",
          count === 0 ? "text-muted-foreground/50" : "text-foreground/80",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "ml-auto font-mono text-2xs tabular-nums",
          count === 0 ? "text-muted-foreground/40" : "text-muted-foreground",
        )}
      >
        {count}
      </span>
      {/* A short rule in the column's own colour: identity without a coloured header block. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-3 top-0 h-[2px] rounded-full",
          count === 0 ? "bg-border" : barClassName,
          count === 0 ? "opacity-100" : "opacity-70",
        )}
      />
    </header>
  );
}

/** The "nothing here" state, sized so an empty column keeps the board's rhythm. */
export function ColumnEmpty({ label }: { label: string }) {
  return (
    <p className="px-3 pb-4 text-2xs text-muted-foreground/45 leading-relaxed">
      No tasks in {label.toLowerCase()}.
    </p>
  );
}

/**
 * One column holding its Tasks — a lifecycle state, or a Workflow Step.
 *
 * `blockersFor` is threaded down rather than each card fetching its own: the board loads the
 * Workspace's dependency edges once, so a column of thirty cards costs one query, not thirty.
 *
 * `data-state` stays on the lifecycle columns and only on them, so nothing downstream can read a
 * Step id where it expected a state; `data-column` carries the namespaced id for both kinds.
 */
export function Column({
  column,
  tasks,
  renderActions,
  blockersFor,
}: {
  column: BoardColumn;
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
}) {
  return (
    <section
      aria-label={`${column.label} column`}
      data-column={column.id}
      {...(column.kind === "state" ? { "data-state": column.state } : {})}
      className="relative flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-sidebar/60"
    >
      <ColumnHeader column={column} count={tasks.length} />
      {tasks.length === 0 ? (
        <ColumnEmpty label={column.label} />
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {tasks.map((task) => (
            <li key={task.id} className={CARD_ENTRANCE_CLASS}>
              <TaskCard
                task={task}
                actions={renderActions?.(task)}
                blockers={blockersFor?.(task.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
