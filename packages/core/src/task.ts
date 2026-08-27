import {
  type CreateTaskInput,
  err,
  ok,
  type Result,
  type TaskDependencyCycleError,
  TaskDependencyErrorCode,
  TaskErrorCode,
  type TaskState,
  taskStateSchema,
} from "@solow/contracts";

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

/**
 * The lifecycle read as an ordered line, so a Task can be nudged one step along it.
 *
 * The order is the contract's own enum, `taskStateSchema.options`, and not a seven-name list
 * written out again here. The board lays its columns out in exactly that order (`BOARD_COLUMNS`
 * in the web app, which core cannot import), so the sequence already has an owner; a third copy
 * of it would be the one nobody looks at, and therefore the one that drifts.
 *
 * Both directions are *derived* from `TRANSITIONS` rather than listed. A hand-written "what
 * comes after review" table would be a second statement of the lifecycle, and the first time
 * someone adds or removes an edge the two would disagree — with the stepping table being the
 * half that offers a move the server then refuses.
 */
const STATE_ORDER: readonly TaskState[] = taskStateSchema.options;

/**
 * Where a Task leaves the line rather than moving along it.
 *
 * Both sit *after* `review` in column order, which is an artefact of where the board draws them
 * and not a statement that they come later in the work. Left in, stepping forward reads them as
 * destinations: a `parked` Task — one waiting on a quota window it will come out of by itself —
 * would be handed a forward arrow whose only meaning is "give up on this", because `failed` is
 * the only legal target to the right of it. Reaching either of them is something that happens to
 * a run, so it is announced by the orchestrator or chosen deliberately on the board, never a
 * nudge one column along.
 */
const EXIT_STATES: readonly TaskState[] = ["parked", "failed"];

/**
 * The legal target nearest to `from` in column order, searching forward (`+1`) or back (`-1`).
 *
 * "Nearest" matters because several states have more than one legal exit in the same direction:
 * `running` may go to `review`, `parked` or `failed`, and only the first of those is the move an
 * arrow should offer. Skipping over `parked` and `failed` to reach `done` would be a fast-forward
 * the Owner did not ask for.
 */
function stepTaskState(from: TaskState, direction: 1 | -1): TaskState | null {
  const origin = STATE_ORDER.indexOf(from);
  let best: TaskState | null = null;
  let bestIndex = -1;

  for (const to of TRANSITIONS[from]) {
    if (direction === 1 && EXIT_STATES.includes(to)) continue;
    const index = STATE_ORDER.indexOf(to);
    if (direction === 1 ? index <= origin : index >= origin) continue;
    if (best === null || (direction === 1 ? index < bestIndex : index > bestIndex)) {
      best = to;
      bestIndex = index;
    }
  }
  return best;
}

/** The state one step forward along the board, or null when the Task cannot advance. */
export function nextTaskState(from: TaskState): TaskState | null {
  return stepTaskState(from, 1);
}

/** The state one step back along the board, or null when the Task cannot retreat. */
export function previousTaskState(from: TaskState): TaskState | null {
  return stepTaskState(from, -1);
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

/**
 * A Task's Repository attachments (issue #7) — the pure half of "which repositories, on which
 * branches", so the orchestrator, the DAL and the board all answer it the same way.
 */

/**
 * The deterministic branch a Task's worktree sits on when the Owner named none.
 *
 * Four places now need the same string and none of them may disagree: the DAL derives it when an
 * attachment omits a branch, the manager asks git for it, the migration that backfilled existing
 * Tasks wrote it — and `setTaskRepositoriesInput` derives it to tell an Owner that two entries
 * are the same attachment written two ways. That last one is a contract, which cannot import
 * this package, so the template lives there and is re-exported here; every consumer keeps
 * importing it from `@solow/core` and there is still exactly one copy of it.
 */
export { taskCheckoutBranch } from "@solow/contracts";

/** The shape "which attachment is primary" is decided from — nothing else about it matters. */
export interface TaskRepositoryPosition {
  position: number;
}

/**
 * The attachment the agent is actually started in (issue #7).
 *
 * This is the *one* place the product picks a single repository out of a Task's several, and it
 * is named rather than being a `[0]` somewhere in the lifecycle. The lifecycle runs the agent in
 * exactly one working directory — that is the stated limitation of multi-repository Tasks, not
 * an accident — so something has to answer "which one", and the answer must be the same on every
 * read. It is decided by `position`, which a unique `(task_id, position)` index makes
 * single-valued, rather than by the order rows happened to come back in.
 *
 * Throws on an empty list. A Task with no attachment cannot be run at all, and returning
 * `undefined` here would move the failure to whichever caller forgot to check — three steps
 * later, with nothing left to point at.
 */
export function primaryTaskRepository<T extends TaskRepositoryPosition>(
  attachments: readonly T[],
): T {
  let primary: T | undefined;
  for (const attachment of attachments) {
    if (!primary || attachment.position < primary.position) primary = attachment;
  }
  if (!primary) throw new Error("task has no repository attached");
  return primary;
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
