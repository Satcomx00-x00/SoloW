/**
 * Where a link to a Task should land. A Task waiting at its gate opens on the Changes view, so
 * the decision is one click from wherever the link was; every other state keeps the board.
 */
export function taskHref(task: { id: string; state: string }): string {
  return task.state === "review" ? `/task/${task.id}?tab=changes` : `/task/${task.id}`;
}
