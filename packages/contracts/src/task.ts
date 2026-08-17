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
