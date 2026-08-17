import {
  type CreateTaskInput,
  err,
  ok,
  type Result,
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
