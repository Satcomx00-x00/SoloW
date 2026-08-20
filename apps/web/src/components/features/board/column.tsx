import type { TaskDependencyDto, TaskDto, TaskState } from "@gatecontrol/contracts";
import type { ReactNode } from "react";
import { STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { TaskCard } from "./task-card";

/**
 * The head of a lifecycle column: the state's own glyph, its name, and how many sit in it.
 *
 * Shared by the plain column and the draggable one so the two cannot drift apart — they are the
 * same column, one of them just also accepts a drop.
 */
export function ColumnHeader({
  state,
  label,
  count,
}: {
  state: TaskState;
  label: string;
  count: number;
}) {
  const { icon: Icon, textClassName, barClassName, hint } = STATE_STYLE[state];
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
      {/* A short rule in the state's colour: column identity without a coloured header block. */}
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
 * One lifecycle-state column holding its Tasks.
 *
 * `blockersFor` is threaded down rather than each card fetching its own: the board loads the
 * Workspace's dependency edges once, so a column of thirty cards costs one query, not thirty.
 */
export function Column({
  state,
  label,
  tasks,
  renderActions,
  blockersFor,
}: {
  state: TaskState;
  label: string;
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
  blockersFor?: ((taskId: string) => readonly TaskDependencyDto[] | undefined) | undefined;
}) {
  return (
    <section
      aria-label={`${label} column`}
      data-state={state}
      className="relative flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border bg-sidebar/60"
    >
      <ColumnHeader state={state} label={label} count={tasks.length} />
      {tasks.length === 0 ? (
        <ColumnEmpty label={label} />
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
          {tasks.map((task) => (
            <li key={task.id}>
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
