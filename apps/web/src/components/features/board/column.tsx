import type { TaskDto, TaskState } from "@gatecontrol/contracts";
import { TaskCard } from "./task-card";

/** One lifecycle-state column holding its Tasks. */
export function Column({
  state,
  label,
  tasks,
}: {
  state: TaskState;
  label: string;
  tasks: TaskDto[];
}) {
  return (
    <section className="column" aria-label={`${label} column`} data-state={state}>
      <header>
        <span>{label}</span>
        <span className="count">{tasks.length}</span>
      </header>
      {tasks.length === 0 ? (
        <p className="empty">No tasks</p>
      ) : (
        <ul>
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </ul>
      )}
    </section>
  );
}
