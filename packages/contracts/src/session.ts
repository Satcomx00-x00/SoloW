import { z } from "zod";
import { idSchema, sessionStateSchema, taskStateSchema } from "./common.js";
import { todoItemSchema } from "./events.js";
import { reviewDto } from "./review.js";
import { widgetSchema } from "./widget.js";

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
  /**
   * Which Repository this change belongs to (issue #7 AC-4) — a Task now spans several, and a
   * reviewer reading one flat file list could not tell which repository a path came from.
   *
   * Optional, and deliberately so: the payload is parsed back out of the append-only session
   * log, so a `diff` event written before multi-repository Tasks existed still has to parse.
   * An event without them is presented as an unlabelled group rather than dropped.
   */
  repositoryId: z.string().optional(),
  repositoryName: z.string().optional(),
});
export type TaskDiffDto = z.infer<typeof taskDiffDto>;

/** One of the choices the agent offered when it asked for permission (issue #58, AC-4). */
const permissionOption = z.object({
  optionId: z.string().min(1),
  name: z.string(),
  kind: z.string(),
});

/**
 * What one line of a Conversation *is* (issue #2, AC-1).
 *
 * The log used to be opaque JSON that every reader sniffed — the workspace probed for `text`,
 * then `name`, then gave up and stringified — which meant nothing downstream could tell a user
 * turn from an assistant turn from a tool call. Redaction (#16), the MCP conversation surface
 * (#84) and sub-task forking (#9) each need that distinction before they can be built at all.
 *
 * The discriminator lives *inside* the payload rather than only on `session_event.kind`, so a
 * row is self-describing when it travels without its column — through a snapshot export, an MCP
 * response, a hash. The column keeps being written with the identical string, so every existing
 * index, filter and query still works, and `parseSessionEventPayload` below keeps every row
 * written before this union existed readable (see its comment).
 */
export const sessionEventPayloadSchema = z.discriminatedUnion("kind", [
  /** Something a human said to the agent — the Task brief, or steering from the terminal. */
  z.object({ kind: z.literal("user_turn"), text: z.string() }),
  /**
   * Something the model said. `thinking` separates reasoning from the answer; it is a property
   * of the record, not of its presentation, so the "· " marker the terminal shows is applied on
   * the way to the wire and never stored (see `toTaskEvent` in the orchestrator).
   */
  z.object({ kind: z.literal("assistant_turn"), text: z.string(), thinking: z.boolean() }),
  /** Machinery talking about itself: a mode switch, a stop reason, a run-level message. */
  z.object({ kind: z.literal("notice"), text: z.string() }),
  /**
   * A tool the agent invoked.
   *
   * `input` was declared and deliberately unpopulated for a long time, because a tool call's raw
   * input can hold the contents of a file being written — exactly the class of value that must
   * never reach a durable payload (Principle IV). It is populated now, but only through a
   * **per-tool allowlist of argument keys**, applied once in `task-run.ts` so both the ACP and
   * the Claude Code producers inherit it, and applied *before* the existing secret redaction
   * rather than instead of it.
   *
   * What that admits: a path, a command, a search pattern. What it refuses, permanently:
   * `Write.content` and `Edit.new_string`. The rule lives with the producer, not here, because
   * this schema cannot know which key of which tool is safe — but the guarantee it encodes is
   * that `input` is a flat map of short strings, never an arbitrary blob.
   */
  z.object({
    kind: z.literal("tool_call"),
    name: z.string(),
    /** The protocol's id for the call, or null for an adapter that reports none. */
    callId: z.string().nullable(),
    input: z.record(z.string()).nullish(),
    /**
     * Nullish, never required: every `tool_call` row written before this field existed must keep
     * parsing here, or it falls through to the legacy coercion below and loses its shape.
     */
    status: z.enum(["pending", "in_progress", "completed", "failed"]).nullish(),
  }),
  /**
   * How a tool call finished. `output` is truncated by the producer with an explicit marker —
   * a `Read` result is a whole file, and compaction will not save the log from it
   * (`SESSION_COMPACTION_THRESHOLD` counts events, not bytes).
   */
  z.object({
    kind: z.literal("tool_result"),
    callId: z.string().nullable(),
    ok: z.boolean(),
    output: z.string().nullish(),
    truncated: z.boolean().nullish(),
  }),
  /**
   * One turn's token usage. Defined here so #64 has a place to land at zero extra cost, and
   * unpopulated for now: `session_usage` already owns this fact, and writing it twice would
   * create the second source of truth the conventions forbid.
   */
  z.object({
    kind: z.literal("usage"),
    model: z.string().nullable(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    costUsd: z.number().optional(),
  }),
  /** A Task state change, recorded in the log so the transcript explains its own shape. */
  z.object({
    kind: z.literal("state"),
    from: taskStateSchema,
    to: taskStateSchema,
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("permission_request"),
    requestId: z.string().min(1),
    title: z.string(),
    toolKind: z.string().nullable(),
    /** Nullish for the same reason as `tool_call.status`: rows predate the field. */
    toolCallId: z.string().nullish(),
    options: z.array(permissionOption),
  }),
  z.object({
    kind: z.literal("permission_resolved"),
    requestId: z.string().min(1),
    optionId: z.string().nullable(),
    decidedBy: z.enum(["operator", "policy"]),
  }),
  /** The change captured at the review gate — the same shape `taskDiffDto` already described. */
  z.object({ kind: z.literal("diff"), ...taskDiffDto.shape }),
  /**
   * Something the agent asked the frontend to draw rather than say (see `widget.ts`).
   *
   * `widgetId` is this build's id for the emission, not the agent's: an agent may emit the same
   * widget twice, and the answer has to name one of them. It is what a `widget_response` refers
   * back to, exactly as `requestId` ties a permission to its resolution.
   */
  z.object({ kind: z.literal("widget"), widgetId: z.string().min(1), widget: widgetSchema }),
  /**
   * The agent's own todo list, recorded instead of the `TodoWrite` call that carried it.
   *
   * The call itself was a contentless row: the argument allowlist admits none of `TodoWrite`'s
   * input, because the list is an array of objects and `tool_call.input` is bounded to a flat
   * map of short strings — so the transcript could say only "tool: TodoWrite", and the plan
   * every reader actually wanted was thrown away. Storing the list is what makes it survive.
   *
   * The list is stored whole on every rewrite rather than as a diff against the last one. That
   * is redundant on purpose: the log is append-only evidence (Principle I), and a row that only
   * means something in the light of the rows before it cannot be read out of a summarised range
   * or a snapshot.
   */
  z.object({ kind: z.literal("todos"), items: z.array(todoItemSchema).max(100) }),
  /**
   * What a person answered. Logged as its own record rather than folded into the widget's row,
   * for the reason the permission channel keeps `permission_resolved` separate: the question and
   * the answer happened at different times, and a log that collapses them cannot say how long
   * the run waited or whether anyone was there at all.
   */
  z.object({
    kind: z.literal("widget_response"),
    widgetId: z.string().min(1),
    values: z.array(z.string()),
    text: z.string().nullish(),
  }),
]);
export type SessionEventPayload = z.infer<typeof sessionEventPayloadSchema>;

export const sessionEventKindSchema = z.enum([
  "user_turn",
  "assistant_turn",
  "notice",
  "tool_call",
  "tool_result",
  "usage",
  "state",
  "permission_request",
  "permission_resolved",
  "diff",
  "widget",
  "widget_response",
  "todos",
]);
export type SessionEventKind = z.infer<typeof sessionEventKindSchema>;

/**
 * Read a stored payload back, whatever era wrote it. Total — it never throws and never returns
 * null, because a Session recorded before this union existed still has to render.
 *
 * Migration 0012 rewrites no rows (see F11 "States & rules"): a backfill that mis-guesses one
 * historical shape corrupts evidence the review gate is required to keep (Principle I), and it
 * would have to be hand-written SQL besides. So compatibility is a read-time mapping keyed on
 * the `kind` *column* — the same discriminator the wire projection has always used:
 *
 *   - `stdout` + `{text}`  → an assistant turn. This asserts a provenance the row does not
 *     record, and is the one judgement call here: legacy `stdout` was produced by assistant
 *     text, thinking, an ACP user echo, mode lines and stop reasons, of which assistant text is
 *     overwhelmingly the bulk. Reading them all as `notice` instead would render every finished
 *     Task's transcript as an undifferentiated wall — a visible regression on exactly the runs
 *     this compatibility exists to protect. `thinking` is genuinely unrecoverable and is false.
 *   - `tool_use` + `{name}` → a tool call with no call id.
 *   - `diff`, `permission_request`, `permission_resolved` → the same object, tagged. These
 *     shapes already matched their variants field for field, so the ACP client's events (#58)
 *     read back identically in both directions.
 *   - anything else → a notice holding the JSON. That is precisely what the client's old
 *     `eventText()` fallback did, moved server-side and made total.
 */
export function parseSessionEventPayload(kind: string, payload: unknown): SessionEventPayload {
  const typed = sessionEventPayloadSchema.safeParse(payload);
  if (typed.success) return typed.data;

  const p = (payload ?? {}) as Record<string, unknown>;
  const legacy = sessionEventPayloadSchema.safeParse({ ...p, kind });
  if (legacy.success) return legacy.data;

  if (kind === "stdout") {
    return { kind: "assistant_turn", text: String(p["text"] ?? ""), thinking: false };
  }
  if (kind === "tool_use") {
    return { kind: "tool_call", name: String(p["name"] ?? ""), callId: null };
  }
  return { kind: "notice", text: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

export const sessionEventDto = z.object({
  id: idSchema,
  sessionId: idSchema,
  seq: z.number().int(),
  /** Always equal to `payload.kind` — the column and the payload cannot disagree. */
  kind: sessionEventKindSchema,
  payload: sessionEventPayloadSchema,
  at: z.string().datetime(),
});
export type SessionEventDto = z.infer<typeof sessionEventDto>;

/**
 * A summary standing in for a closed range of the log (issue #2, AC-2/AC-3).
 *
 * Compaction inserts one of these and stops. It never deletes and never mutates: the events the
 * range covers are still there, still replayable, still the evidence the review gate kept
 * (Principle I). A summary is an index into the log, not a replacement for it — which is why
 * the UI's collapsed range can always be expanded back into the events themselves.
 */
export const sessionSummaryDto = z.object({
  id: idSchema,
  sessionId: idSchema,
  /** Inclusive on both ends. */
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  text: z.string(),
  at: z.string().datetime(),
});
export type SessionSummaryDto = z.infer<typeof sessionSummaryDto>;

/**
 * A fork point another run can start from (issue #2, AC-4; unblocks #9).
 *
 * `(sessionId, seq)` addresses the point; `hash` proves the history behind it is the same
 * history that was there when the cursor was minted. A child Task that forks from a parent
 * transcript has to be able to say "start from here" *and* be refused if "here" was rewritten
 * underneath it — a resume that silently continues from a different history is worse than one
 * that fails.
 */
export const sessionCursorDto = z.object({
  sessionId: idSchema,
  seq: z.number().int().nonnegative(),
  /** `sha256:<hex>` over every event up to and including `seq`. */
  hash: z.string().min(1),
});
export type SessionCursorDto = z.infer<typeof sessionCursorDto>;

/**
 * Read from a fork point. The cursor's three fields are the input, flat rather than nested:
 * this is a GET, and its whole input has to survive a query string.
 */
export const sessionEventsFromInput = sessionCursorDto;
export type SessionEventsFromInput = z.infer<typeof sessionEventsFromInput>;

/**
 * Read one summarised range back out of the log (issue #2, AC-3).
 *
 * `session.get` leaves out the events a summary stands in for, so this is how the collapsed row
 * expands: the range is fetched when an operator asks for it and not before. Bounds are the
 * summary's own `[fromSeq, toSeq]`, inclusive on both ends.
 */
export const sessionEventRangeInput = z.object({
  sessionId: idSchema,
  fromSeq: z.number().int().nonnegative(),
  toSeq: z.number().int().nonnegative(),
});
export type SessionEventRangeInput = z.infer<typeof sessionEventRangeInput>;

export const sessionForkCursorInput = z.object({
  sessionId: idSchema,
  /** The head of the log when omitted. */
  seq: z.number().int().nonnegative().optional(),
});
export type SessionForkCursorInput = z.infer<typeof sessionForkCursorInput>;

/**
 * Session-log error codes. Defined beside the cursor they describe rather than in `errors.ts`
 * so the contract and its refusal read as one thing; `unwrap` maps an unmapped code to
 * `BAD_REQUEST` carrying the code as its message, which is the behaviour a stale cursor wants.
 */
export const SessionErrorCode = {
  /**
   * The log behind the cursor changed — the fork point no longer means what it meant. A cursor
   * naming a `seq` the log simply does not have is `NOT_FOUND` instead: only one of the two is
   * evidence that something rewrote history.
   */
  CursorStale: "SESSION_CURSOR_STALE",
} as const;
export type SessionErrorCode = (typeof SessionErrorCode)[keyof typeof SessionErrorCode];

export const sessionDetailDto = z.object({
  session: sessionDto,
  /**
   * The log, minus the ranges a summary already stands in for.
   *
   * Compaction is the answer this feature gives to a run that grows without bound, and a summary
   * that arrived *on top of* every event it covers would not be an answer at all — the response
   * would still carry the whole log and the workspace would still mount every row of it. The
   * events themselves are untouched and still readable one range at a time through
   * `session.eventRange` (AC-2): what is elided here is a view, not a record.
   */
  events: z.array(sessionEventDto),
  review: reviewDto.nullable(),
  /**
   * The primary Repository's change — the first entry of `diffs`, or null until the agent
   * reaches the review gate. Kept alongside `diffs` so a caller that only ever wanted "the
   * change" (the MCP surface, an external OpenAPI client) needs no change to keep working.
   */
  diff: taskDiffDto.nullable(),
  /** One entry per Repository the Task changed, in attachment order (issue #7 AC-4). */
  diffs: z.array(taskDiffDto),
  /**
   * Ranges compaction has already summarised, oldest first. Never covers the whole log — the
   * tail an operator is actually reading is left alone — and never overlaps another range.
   */
  summaries: z.array(sessionSummaryDto),
  /** The fork point at the head of the log, or null while the log is still empty. */
  cursor: sessionCursorDto.nullable(),
});
export type SessionDetailDto = z.infer<typeof sessionDetailDto>;
