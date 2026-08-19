import { z } from "zod";
import { idSchema, sessionStateSchema } from "./common.js";
import { reviewDto } from "./review.js";

/** Read contracts for agent Sessions and their streamed event log (spec F09/F10). */

export const getTaskSessionsInput = z.object({ taskId: idSchema });
export type GetTaskSessionsInput = z.infer<typeof getTaskSessionsInput>;

export const getSessionInput = z.object({ sessionId: idSchema });
export type GetSessionInput = z.infer<typeof getSessionInput>;

export const sessionDto = z.object({
  id: idSchema,
  taskId: idSchema,
  state: sessionStateSchema,
  diffRef: z.string().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
});
export type SessionDto = z.infer<typeof sessionDto>;

export const sessionEventDto = z.object({
  id: idSchema,
  sessionId: idSchema,
  seq: z.number().int(),
  kind: z.string(),
  // Arbitrary agent-event payload (stdout text, tool name, diff ref) — read-only, so it is
  // intentionally opaque here rather than narrowed per kind.
  payload: z.unknown(),
  at: z.string().datetime(),
});
export type SessionEventDto = z.infer<typeof sessionEventDto>;

/**
 * The change an agent is proposing (task TASK-022 diff view).
 *
 * Captured by the orchestrator at the review gate and persisted to the session log, so it is
 * still readable after the worktree is torn down — an approved Task can show what was approved.
 * The patch is bounded; the file list never is, because that is what a reviewer scans first.
 */
export const diffFileDto = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffFileDto = z.infer<typeof diffFileDto>;

export const taskDiffDto = z.object({
  /** The branch the change sits on. */
  diffRef: z.string(),
  files: z.array(diffFileDto),
  patch: z.string(),
  /** True when `patch` was cut short. `files` is always complete. */
  truncated: z.boolean(),
});
export type TaskDiffDto = z.infer<typeof taskDiffDto>;

export const sessionDetailDto = z.object({
  session: sessionDto,
  events: z.array(sessionEventDto),
  review: reviewDto.nullable(),
  /** Null until the agent reaches the review gate, or if the capture failed. */
  diff: taskDiffDto.nullable(),
});
export type SessionDetailDto = z.infer<typeof sessionDetailDto>;
