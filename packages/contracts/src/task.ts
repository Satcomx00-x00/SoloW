import { z } from "zod";
import { idSchema, taskStateSchema, timestampsSchema } from "./common.js";

export const createTaskInput = z.object({
  issueId: idSchema,
  title: z.string().min(1).max(200),
  agentProfileId: idSchema,
  executorProfileId: idSchema,
  repositoryId: idSchema,
  /** Base branch/commit the worktree starts from; defaults server-side when omitted. */
  baseRef: z.string().min(1).max(200).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInput>;

export const launchTaskInput = z.object({ id: idSchema });
export type LaunchTaskInput = z.infer<typeof launchTaskInput>;

export const moveTaskInput = z.object({
  id: idSchema,
  to: taskStateSchema,
});
export type MoveTaskInput = z.infer<typeof moveTaskInput>;

export const retryTaskInput = z.object({ id: idSchema });
export type RetryTaskInput = z.infer<typeof retryTaskInput>;

export const listTasksInput = z.object({
  issueId: idSchema.optional(),
  state: taskStateSchema.optional(),
  query: z.string().max(200).optional(),
});
export type ListTasksInput = z.infer<typeof listTasksInput>;

export const getTaskInput = z.object({ id: idSchema });
export type GetTaskInput = z.infer<typeof getTaskInput>;

export const taskDto = z
  .object({
    id: idSchema,
    issueId: idSchema,
    title: z.string(),
    state: taskStateSchema,
    agentProfileId: idSchema,
    executorProfileId: idSchema,
    repositoryId: idSchema,
    baseRef: z.string().nullable(),
    resultBranch: z.string().nullable(),
    failureReason: z.string().nullable(),
  })
  .merge(timestampsSchema);
export type TaskDto = z.infer<typeof taskDto>;

export const taskListDto = z.array(taskDto);
export type TaskListDto = z.infer<typeof taskListDto>;

/**
 * Task dependencies — `blocked_by` edges (issue #6).
 *
 * The codes live here rather than in `errors.ts` because `Cycle` is the only error in the
 * product that carries a payload: refusing an edge is useless unless the caller is told *which*
 * path it would have closed, so the error is an object and belongs beside the schemas that
 * describe it.
 */
export const TaskDependencyErrorCode = {
  /** The declared edge would close a cycle; the offending path travels with it (AC-2). */
  Cycle: "TASK_DEPENDENCY_CYCLE",
  /** The Task has at least one predecessor that is not yet `done` (AC-3). */
  Blocked: "TASK_BLOCKED",
} as const;
export type TaskDependencyErrorCode =
  (typeof TaskDependencyErrorCode)[keyof typeof TaskDependencyErrorCode];

export interface TaskDependencyCycleError {
  code: typeof TaskDependencyErrorCode.Cycle;
  /**
   * The cycle the edge would have closed, starting and ending on the Task being blocked:
   * `[A, B, C, A]` reads "A is blocked by B, which is blocked by C, which is blocked by A".
   */
  path: readonly string[];
}

/**
 * `workspaceId` is absent on purpose — it is the tenant key and comes from the session, so an
 * edge can never be aimed at another Workspace by asking for one (Principle V, see `common.ts`).
 */
export const addTaskDependencyInput = z.object({
  taskId: idSchema,
  blockedByTaskId: idSchema,
});
export type AddTaskDependencyInput = z.infer<typeof addTaskDependencyInput>;

export const removeTaskDependencyInput = addTaskDependencyInput;
export type RemoveTaskDependencyInput = z.infer<typeof removeTaskDependencyInput>;

export const listTaskDependenciesInput = z.object({ taskId: idSchema.optional() });
export type ListTaskDependenciesInput = z.infer<typeof listTaskDependenciesInput>;

/**
 * One edge, resolved. The blocker's title and state ride along because the question the board
 * asks is never "which ids block this" but "why is this still blocked" — answering it from the
 * edge alone would cost a second round trip per card.
 */
export const taskDependencyDto = z.object({
  taskId: idSchema,
  blockedByTaskId: idSchema,
  blockedByTitle: z.string(),
  blockedByState: taskStateSchema,
  createdAt: z.string().datetime(),
});
export type TaskDependencyDto = z.infer<typeof taskDependencyDto>;

export const taskDependencyListDto = z.array(taskDependencyDto);
export type TaskDependencyListDto = z.infer<typeof taskDependencyListDto>;
