import {
  type CreateTaskInput,
  err,
  ok,
  type Result,
  type TaskDependencyCycleError,
  TaskDependencyErrorCode,
  TaskErrorCode,
  type TaskState,
} from "@gatecontrol/contracts";

/**
 * Pure Task business logic (plan §5). Zero infrastructure imports; returns `Result`,
 * never throws on a business error (constitution Principle VI).
 */

/** Allowed Task state transitions (spec Domain Model lifecycle). */
const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  backlog: ["ready"],
  ready: ["running", "backlog"],
  running: ["review", "parked", "failed"],
  review: ["done", "running", "ready"], // approve → done; request_changes → running; reject → ready
  parked: ["running", "failed"],
  failed: ["running"], // retry
  done: [],
};

export function canTransitionTask(
  from: TaskState,
  to: TaskState,
): Result<void, typeof TaskErrorCode.IllegalTransition> {
  return TRANSITIONS[from].includes(to) ? ok(undefined) : err(TaskErrorCode.IllegalTransition);
}

export interface TaskCreatePayload extends CreateTaskInput {
  workspaceId: string;
  state: TaskState;
}

/** Build the persistence payload for a new Task (state starts at `backlog`). */
export function buildCreateTaskPayload(
  input: CreateTaskInput,
  ctx: { workspaceId: string },
): Result<TaskCreatePayload> {
  return ok({ ...input, workspaceId: ctx.workspaceId, state: "backlog" });
}

/** A Task is launchable only from `ready`. */
export function isLaunchable(state: TaskState): boolean {
  return state === "ready";
}

/**
 * Task dependencies (issue #6) — the whole graph story, and nothing else.
 *
 * Every rule below is a pure function over an adjacency map, deliberately kept out of the DAL:
 * the acyclicity invariant is the one thing SQLite cannot express as a constraint (reachability
 * is not a column), so it has to be a decision made in code, and a decision made in code is
 * only trustworthy if it is testable without a database (Principle VI).
 */

/** One `blocked_by` edge: `taskId` cannot start until `blockedByTaskId` is done. */
export interface TaskDependencyEdge {
  taskId: string;
  blockedByTaskId: string;
}

/** Task id → the ids it is blocked by. Direction matters: it is the one the DFS walks. */
export type DependencyGraph = ReadonlyMap<string, readonly string[]>;

export function buildDependencyGraph(edges: Iterable<TaskDependencyEdge>): DependencyGraph {
  const graph = new Map<string, string[]>();
  for (const edge of edges) {
    const blockers = graph.get(edge.taskId);
    if (blockers) blockers.push(edge.blockedByTaskId);
    else graph.set(edge.taskId, [edge.blockedByTaskId]);
  }
  return graph;
}

/**
 * Walk `blocked_by` edges from `from` looking for `target`, returning the path that reaches it.
 *
 * Iterative with an explicit stack and a parent map rather than the obvious recursion: a
 * Workspace's dependency chain is Owner-authored data with no bound on its length, and a
 * recursive DFS would turn a long-but-legal chain into a stack overflow — a crash on valid
 * input, at the exact moment the product is being asked to protect the graph.
 */
function findDependencyPath(graph: DependencyGraph, from: string, target: string): string[] | null {
  if (from === target) return [from];
  const parent = new Map<string, string | null>([[from, null]]);
  const stack: string[] = [from];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    for (const next of graph.get(node) ?? []) {
      if (parent.has(next)) continue;
      parent.set(next, node);
      if (next === target) {
        const path: string[] = [];
        for (let at: string | null | undefined = next; at != null; at = parent.get(at)) {
          path.push(at);
        }
        return path.reverse();
      }
      stack.push(next);
    }
  }
  return null;
}

/**
 * Would adding `edge` to `graph` close a cycle? Answered before the insert, never at schedule
 * time: a cycle discovered when something tries to start is a Task that silently never runs,
 * with nothing left to point at (issue #6, rule 1).
 *
 * The reported path starts and ends on the Task being blocked, so it reads as the sentence the
 * Owner has to act on — `A → B → C → A`.
 */
export function checkDependencyEdge(
  graph: DependencyGraph,
  edge: TaskDependencyEdge,
): Result<void, TaskDependencyCycleError> {
  if (edge.taskId === edge.blockedByTaskId) {
    return err({ code: TaskDependencyErrorCode.Cycle, path: [edge.taskId, edge.taskId] });
  }
  // The edge closes a cycle exactly when its blocker is already, transitively, blocked by the
  // Task being blocked — i.e. when `taskId` is reachable from `blockedByTaskId`.
  const path = findDependencyPath(graph, edge.blockedByTaskId, edge.taskId);
  if (!path) return ok(undefined);
  return err({ code: TaskDependencyErrorCode.Cycle, path: [edge.taskId, ...path] });
}

/** The shape readiness is decided from — a blocker and the state it is currently in. */
export interface TaskDependencyStatus {
  blockedByTaskId: string;
  blockedByState: TaskState;
}

/**
 * The predecessors that are not yet `done`.
 *
 * Readiness is derived here and stored nowhere. A persisted "blocked" flag would need something
 * to clear it, and whatever that something is would be the thing that fails to run — leaving a
 * Task that can never start even though its dependencies are all satisfied (AC-4).
 */
export function unsatisfiedDependencies<T extends TaskDependencyStatus>(
  deps: readonly T[],
): readonly T[] {
  return deps.filter((dep) => dep.blockedByState !== "done");
}

export function isBlocked(deps: readonly TaskDependencyStatus[]): boolean {
  return unsatisfiedDependencies(deps).length > 0;
}

/**
 * The wire form of a cycle path. Formatting and parsing sit together so the server that writes
 * the message and the dialog that renders it cannot disagree about the separator.
 */
const CYCLE_SEPARATOR = " → ";

export function formatDependencyCycle(path: readonly string[]): string {
  return path.join(CYCLE_SEPARATOR);
}

/** Recover the path from a `TASK_DEPENDENCY_CYCLE: a → b → a` error message; null if it is not one. */
export function parseDependencyCycleMessage(message: string): readonly string[] | null {
  const prefix = `${TaskDependencyErrorCode.Cycle}: `;
  if (!message.startsWith(prefix)) return null;
  const path = message.slice(prefix.length).split(CYCLE_SEPARATOR);
  return path.length >= 2 ? path : null;
}
