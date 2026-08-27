import type { TaskDto, TaskState } from "@solow/contracts";

/**
 * What a project row says about the agent runs underneath it.
 *
 * The planning table sits above execution ([Decision 0006](../../../../../docs/decisions/0006-issue-task-separation.md)),
 * and F23 FR-14 asks the two layers to be one click apart: a row that plans work should say
 * whether an agent is on it, waiting for you, or has failed. This is the summary a single cell
 * can hold.
 */
export interface RowTaskSummary {
  /** The one state the cell shows — see `RANK` for why this one and not the newest. */
  state: TaskState;
  /** How many Tasks the row has in total, so a cell can say "3" beside the state it shows. */
  total: number;
}

/**
 * Which state wins when a row has several Tasks, most demanding first.
 *
 * Not "the newest". A row whose latest run is `done` while an earlier one sits in `review` is a
 * row that still needs a person, and showing `done` would file it as finished — the one summary
 * a reviewer must never be given wrongly. So the order is by how much the state asks of the
 * reader: `review` and `failed` want you now, `running` is in flight, and the rest are quiet.
 *
 * `review` above `failed` deliberately: a failed run is retried by whoever gets to it, while a
 * review is the gate nothing passes without a human (Principle I).
 */
const RANK: readonly TaskState[] = [
  "review",
  "failed",
  "running",
  "parked",
  "ready",
  "backlog",
  "done",
];

/**
 * Summarise one row's Tasks.
 *
 * Null for a row with none — which is *not* the same as a row whose Tasks are all done, and the
 * cell renders the two differently: nothing at all versus a `done` badge.
 */
export function summariseRowTasks(tasks: readonly TaskDto[]): RowTaskSummary | null {
  if (tasks.length === 0) return null;
  let best: TaskState | null = null;
  for (const task of tasks) {
    if (best === null || RANK.indexOf(task.state) < RANK.indexOf(best)) best = task.state;
  }
  // Unreachable while `tasks` is non-empty, and typed rather than asserted: a state the enum
  // gains without `RANK` gaining it would land here rather than silently sorting first.
  if (best === null) return null;
  return { state: best, total: tasks.length };
}

/** Index a Workspace's Tasks by the Issue they run on, for a table that renders row by row. */
export function tasksByIssue(tasks: readonly TaskDto[]): Map<string, TaskDto[]> {
  const byIssue = new Map<string, TaskDto[]>();
  for (const task of tasks) {
    const found = byIssue.get(task.issueId);
    if (found) found.push(task);
    else byIssue.set(task.issueId, [task]);
  }
  return byIssue;
}
