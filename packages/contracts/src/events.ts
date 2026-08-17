import { z } from "zod";
import { idSchema, taskStateSchema } from "./common.js";

/**
 * WebSocket payloads (Decision 0011). Not part of `openapi.json` — the realtime
 * channel is documented separately.
 */

export const taskEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stdout"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("status"),
    taskId: idSchema,
    state: taskStateSchema,
    at: z.string().datetime(),
  }),
  z.object({
    kind: z.literal("tool_use"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    name: z.string(),
  }),
  z.object({
    kind: z.literal("diff"),
    taskId: idSchema,
    sessionId: idSchema,
    diffRef: idSchema,
  }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** Client → server messages on the task input channel. */
export const taskInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("input"), taskId: idSchema, data: z.string() }),
  z.object({ kind: z.literal("stop"), taskId: idSchema }),
]);
export type TaskInput = z.infer<typeof taskInputSchema>;
