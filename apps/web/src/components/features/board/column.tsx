import type { TaskDto, TaskState } from "@gatecontrol/contracts";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { STATE_BADGE } from "@/lib/task-states";
import { TaskCard } from "./task-card";

/** One lifecycle-state column holding its Tasks. */
export function Column({
  state,
  label,
  tasks,
  renderActions,
}: {
  state: TaskState;
  label: string;
  tasks: TaskDto[];
  renderActions?: ((task: TaskDto) => ReactNode) | undefined;
}) {
  return (
    <section
      aria-label={`${label} column`}
      data-state={state}
      className="flex w-64 shrink-0 flex-col rounded-lg border bg-muted/40"
    >
      <header className="flex items-center justify-between px-3 py-2.5">
        <span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
          {label}
        </span>
        <Badge variant={STATE_BADGE[state]}>{tasks.length}</Badge>
      </header>
      {tasks.length === 0 ? (
        <p className="px-3 pb-3 text-muted-foreground text-xs">No tasks</p>
      ) : (
        <ul className="flex flex-col gap-2 px-2 pb-2">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} actions={renderActions?.(task)} />
          ))}
        </ul>
      )}
    </section>
  );
}
