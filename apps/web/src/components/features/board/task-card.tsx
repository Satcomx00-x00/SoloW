import type { TaskDto } from "@gatecontrol/contracts";

/** A single Task card on the board. */
export function TaskCard({ task }: { task: TaskDto }) {
  const detail = task.failureReason
    ? `⚠ ${task.failureReason}`
    : (task.resultBranch ?? task.id.slice(0, 8));
  return (
    <li className="card">
      <div className="title">{task.title}</div>
      <div className="meta">{detail}</div>
    </li>
  );
}
