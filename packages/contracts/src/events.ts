import { z } from "zod";
import { idSchema, taskStateSchema } from "./common.js";
import { widgetSchema } from "./widget.js";

/**
 * WebSocket payloads (Decision 0011). Not part of `openapi.json` — the realtime
 * channel is documented separately.
 */

/**
 * One line of the plan the agent keeps for itself.
 *
 * Defined once, here, and imported by the persisted union in `session.ts` for the same reason
 * `widgetSchema` is: the wire frame and the durable record carry the identical list, and two
 * declarations of it would drift the moment either side gained a status the other did not know.
 *
 * The bounds are not decoration. A todo list is a handful of short lines an agent rewrites on
 * every turn, so an "item" that is a thousand characters long is a malfunction, not a plan, and
 * the log is the record that outlives the run — its producer cuts anything longer down before
 * it gets here (see `readTodoWrite` in the orchestrator).
 */
export const todoItemSchema = z.object({
  content: z.string().min(1).max(500),
  status: z.enum(["pending", "in_progress", "completed"]),
  /** The present-tense form the agent shows while the item is in progress. */
  activeForm: z.string().max(500).optional(),
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export const taskEventSchema = z.discriminatedUnion("kind", [
  /**
   * A line of agent output, with the channel it came from.
   *
   * `channel` used to be thrown away on the way here — the orchestrator collapsed
   * `assistant_turn` / `user_turn` / `notice` into one `stdout` frame and encoded thinking as a
   * literal "· " prefix on the text. That made the four indistinguishable to any client, so the
   * terminal could not style an operator's own steering differently from the model's answer, and
   * could not render markdown for one without rendering it for the machinery too. The channel
   * travels as data now; the marker, if any, is the renderer's decision.
   */
  z.object({
    kind: z.literal("stdout"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    text: z.string(),
    channel: z.enum(["assistant", "thinking", "user", "system"]),
  }),
  z.object({
    kind: z.literal("status"),
    taskId: idSchema,
    state: taskStateSchema,
    at: z.string().datetime(),
  }),
  /**
   * A tool the agent invoked. `callId` is what lets a client fold a call, its status updates and
   * its result into one row instead of three unrelated lines — without it the terminal could
   * only ever print "tool: Read" and hope.
   *
   * `input` carries only what the orchestrator's per-tool allowlist admits (see `task-run.ts`):
   * a path, a command, a pattern — never the contents of a file being written.
   */
  z.object({
    kind: z.literal("tool_use"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    name: z.string(),
    callId: z.string().nullable(),
    input: z.record(z.string()).nullable(),
    status: z.enum(["pending", "in_progress", "completed", "failed"]).nullable(),
  }),
  /** How a tool call finished. Correlated to its call by `callId`, truncated by the producer. */
  z.object({
    kind: z.literal("tool_result"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    callId: z.string().nullable(),
    ok: z.boolean(),
    output: z.string().nullable(),
    truncated: z.boolean(),
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
    /** The tool call this question is about, so the widget can sit next to it in the transcript. */
    toolCallId: z.string().nullable(),
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
  /**
   * Something the agent asked the frontend to draw (see `widget.ts`). The payload travels whole
   * rather than as a reference the client would have to fetch: a widget is at most a bounded
   * blob, and a transcript row that needs a round trip before it can render is a row that blinks.
   */
  z.object({
    kind: z.literal("widget"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    widgetId: z.string().min(1),
    widget: widgetSchema,
  }),
  /**
   * The agent's own todo list, as it stood after the last time it rewrote it.
   *
   * A whole list rather than a delta: the agent republishes the list entire on every change, and
   * a client that joined halfway through a run — or reconnected — has nothing to apply a delta
   * to. Each of these frames supersedes the one before it, so a renderer keeps the newest and
   * discards the rest rather than accumulating rows the way it does for prose.
   */
  z.object({
    kind: z.literal("todos"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    items: z.array(todoItemSchema).max(100),
  }),
  /** What a person answered — published so every open client settles the same widget at once. */
  z.object({
    kind: z.literal("widget_response"),
    taskId: idSchema,
    sessionId: idSchema,
    seq: z.number().int().nonnegative(),
    widgetId: z.string().min(1),
    values: z.array(z.string()),
    text: z.string().nullable(),
  }),
  /**
   * The mirror moved: a poll brought in provider data that a screen may be showing.
   *
   * The one frame here that is not about a Task, and it is on this channel for a reason. A
   * screen reading mirrored rows has two ways to notice that a background poll changed them:
   * ask again on a timer, or be told. Asking on a timer is the thing this whole design is trying
   * to avoid — it is a request per open tab per interval whether or not anything happened, it is
   * still stale for up to one interval, and shortening the interval to hide that multiplies the
   * cost of finding out that nothing changed.
   *
   * Being told costs one frame on a socket that is already open for the board, and only when
   * something actually changed. A tab left open sees the provider's new issues within a second
   * of the poll writing them, and issues no requests at all in between.
   *
   * `scope` is what a client invalidates, not what changed in detail: the frame is a nudge to
   * re-read, never the data itself. Sending the rows here would make the socket a second way to
   * learn what the API already answers, and the two would disagree the first time one changed.
   */
  z.object({
    kind: z.literal("mirror"),
    scope: z.enum(["issues", "labels"]),
    at: z.string().datetime(),
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
  /**
   * The operator's answer to an interactive widget. Routed exactly like a permission — same
   * ticket, same tenant key, same ack — because it is the same act: a person answering something
   * the agent asked, on the one Task their ticket authorized.
   */
  z.object({
    kind: z.literal("widget_response"),
    taskId: idSchema,
    widgetId: z.string().min(1),
    values: z.array(z.string().min(1)).max(12),
    text: z.string().max(2000).nullish(),
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
  action: z.enum(["input", "stop", "permission", "widget_response"]).optional(),
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
      // A widget answer that found the agent and still could not land: the widget is no longer
      // waiting (answered already, or the run moved on), or the answer named an option the
      // widget never offered. Kept apart from the permission codes so the operator is told which
      // question failed to take their answer.
      "widget_not_pending",
      "widget_option_unknown",
    ])
    .optional(),
});
export type TaskInputAck = z.infer<typeof taskInputAckSchema>;

/** Everything that can arrive on the socket: streamed events, plus acks for what we sent. */
export const taskStreamFrameSchema = z.union([taskEventSchema, taskInputAckSchema]);
export type TaskStreamFrame = z.infer<typeof taskStreamFrameSchema>;
