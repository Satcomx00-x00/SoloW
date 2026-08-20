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
  /**
   * The agent is asking to do something (issue #58, AC-4). Surfaced to the operator rather than
   * silently granted — carrying the agent's own options, never a tool call's raw input, which
   * can hold the contents of a file being written (Principle IV).
   */
  z.object({
    kind: z.literal("permission_request"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    requestId: z.string().min(1),
    title: z.string(),
    toolKind: z.string().nullable(),
    options: z.array(z.object({ optionId: z.string().min(1), name: z.string(), kind: z.string() })),
  }),
  /** How that permission was settled, and by whom — so the log can tell the two apart. */
  z.object({
    kind: z.literal("permission_resolved"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    requestId: z.string().min(1),
    optionId: z.string().nullable(),
    decidedBy: z.enum(["operator", "policy"]),
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
  /** The operator's answer to a permission the agent asked for (issue #58, AC-4). */
  z.object({
    kind: z.literal("permission"),
    taskId: idSchema,
    requestId: z.string().min(1),
    optionId: z.string().min(1),
  }),
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
  action: z.enum(["input", "stop", "permission"]).optional(),
  error: z
    .enum([
      "frame_malformed",
      "frame_not_authorized",
      "agent_not_running",
      // A permission answer that found the agent and still could not land (issue #58, AC-4):
      // the question was already settled, the option was not one the agent offered, or the
      // protocol has no permission channel at all. Distinct from `agent_not_running`, which is
      // what all three used to be reported as.
      "permission_not_pending",
      "permission_option_unknown",
      "permission_unsupported",
    ])
    .optional(),
});
export type TaskInputAck = z.infer<typeof taskInputAckSchema>;

/** Everything that can arrive on the socket: streamed events, plus acks for what we sent. */
export const taskStreamFrameSchema = z.union([taskEventSchema, taskInputAckSchema]);
export type TaskStreamFrame = z.infer<typeof taskStreamFrameSchema>;
