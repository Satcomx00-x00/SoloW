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

/**
 * Subscription ticket (TASK-018 connection auth). The SPA asks the API — which knows the
 * session — for a short-lived ticket naming exactly one channel, then presents it to the
 * orchestrator's WebSocket hub. Omit `taskId` for the Workspace-wide board channel.
 */
export const streamTicketInput = z.object({ taskId: idSchema.optional() });
export type StreamTicketInput = z.infer<typeof streamTicketInput>;

export const streamTicketDto = z.object({
  /** Fully-qualified WebSocket URL including the ticket — connect to it as-is. */
  url: z.string().min(1),
  expiresAt: z.string().datetime(),
});
export type StreamTicketDto = z.infer<typeof streamTicketDto>;

/** Client → server messages on the task input channel. */
export const taskInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("input"), taskId: idSchema, data: z.string() }),
  z.object({ kind: z.literal("stop"), taskId: idSchema }),
]);
export type TaskInput = z.infer<typeof taskInputSchema>;

/**
 * The hub's reply to a client frame. Sent on refusal *and* on success: input that reached no
 * agent — because the run already finished, or the orchestrator restarted — must not look to
 * the operator as though it were delivered.
 */
export const taskInputAckSchema = z.object({
  kind: z.literal("ack"),
  ok: z.boolean(),
  action: z.enum(["input", "stop"]).optional(),
  error: z.enum(["frame_malformed", "frame_not_authorized", "agent_not_running"]).optional(),
});
export type TaskInputAck = z.infer<typeof taskInputAckSchema>;

/** Everything that can arrive on the socket: streamed events, plus acks for what we sent. */
export const taskStreamFrameSchema = z.union([taskEventSchema, taskInputAckSchema]);
export type TaskStreamFrame = z.infer<typeof taskStreamFrameSchema>;
