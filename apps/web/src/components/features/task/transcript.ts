import type { SessionEventDto, TaskEvent, Widget } from "@gatecontrol/contracts";
import { WIDGET_ANSWER_PREFIX } from "@gatecontrol/contracts";

/**
 * The transcript model: one ordered list of rows, built once from every source the Task page has.
 *
 * Three problems live here rather than in the renderer, because all three are about *what the
 * transcript is*, not how it looks.
 *
 * **Duplication.** The page holds the persisted log (from `session.get`) and the live stream at
 * the same time, and the stream's first connection replays from the beginning — so every event
 * of an already-started Task arrives twice, and the old terminal concatenated both. Rows are
 * keyed on `(sessionId, seq)`, which is the identity the orchestrator assigns, and the persisted
 * copy wins: it is the one that survived a round trip through the database.
 *
 * **Coalescing.** An agent's turn arrives as many small chunks — ACP emits one per fragment — and
 * markdown cannot be parsed on a fragment: a fence that has only half arrived would swallow the
 * rest of the transcript on every keystroke of output. Consecutive chunks on the same channel
 * are merged into one block, so a renderer sees turns, not deltas.
 *
 * **Cost.** The old terminal rebuilt the entire transcript as a single string on every render
 * (`preamble + events.map(...).join("") + live.events.map(...).join("")`), inside the component
 * body, unmemoized — O(whole transcript) per arriving chunk, which is the slowness. Building a
 * stable, keyed row list lets the caller memoize the build and the renderer memoize each row.
 *
 * Pure on purpose: no React, no DOM, so the ordering and folding rules are unit-testable.
 */

export type TranscriptChannel = "assistant" | "thinking" | "user" | "system";

export interface TextRow {
  kind: "text";
  id: string;
  sessionId: string;
  seq: number;
  channel: TranscriptChannel;
  text: string;
  /** True while more chunks may still land in this block — the renderer keeps it plain. */
  open: boolean;
}

export interface ToolRow {
  kind: "tool";
  id: string;
  sessionId: string;
  seq: number;
  name: string;
  callId: string | null;
  input: Record<string, string> | null;
  status: "pending" | "in_progress" | "completed" | "failed" | null;
  /** Filled in when the matching `tool_result` arrives, folded into this same row. */
  result: { ok: boolean; output: string | null; truncated: boolean } | null;
}

export interface PermissionRow {
  kind: "permission";
  id: string;
  sessionId: string;
  seq: number;
  requestId: string;
  title: string;
  toolKind: string | null;
  toolCallId: string | null;
  options: Array<{ optionId: string; name: string; kind: string }>;
  /** Null while the question is still open — that is what makes the widget interactive. */
  resolution: { optionId: string | null; decidedBy: "operator" | "policy" } | null;
}

/**
 * Something the agent asked the frontend to draw. The answer, when there is one, is folded into
 * the same row — a widget and its response are one thing on screen, exactly as a permission and
 * its resolution are.
 */
export interface WidgetRow {
  kind: "widget";
  id: string;
  sessionId: string;
  seq: number;
  widgetId: string;
  widget: Widget;
  /** Null while the widget is still waiting — that is what makes it interactive. */
  response: { values: string[]; text: string | null } | null;
}

export interface NoticeRow {
  kind: "notice";
  id: string;
  sessionId: string;
  seq: number;
  text: string;
}

export type TranscriptRow = TextRow | ToolRow | PermissionRow | WidgetRow | NoticeRow;

/** One event, normalised out of whichever source delivered it. */
interface Normalised {
  sessionId: string;
  seq: number;
  payload:
    | { kind: "text"; channel: TranscriptChannel; text: string }
    | {
        kind: "tool_call";
        name: string;
        callId: string | null;
        input: Record<string, string> | null;
        status: ToolRow["status"];
      }
    | {
        kind: "tool_result";
        callId: string | null;
        ok: boolean;
        output: string | null;
        truncated: boolean;
      }
    | {
        kind: "permission_request";
        requestId: string;
        title: string;
        toolKind: string | null;
        toolCallId: string | null;
        options: PermissionRow["options"];
      }
    | {
        kind: "permission_resolved";
        requestId: string;
        optionId: string | null;
        decidedBy: "operator" | "policy";
      }
    | { kind: "widget"; widgetId: string; widget: Widget }
    | { kind: "widget_response"; widgetId: string; values: string[]; text: string | null };
}

/**
 * Whether an operator turn is the machine's copy of a widget answer.
 *
 * The answer reaches the agent as a message, and a protocol that echoes operator input puts that
 * message straight back in the transcript — directly beneath the widget card that already shows,
 * in the operator's own words, what they picked. One of the two is a duplicate, and it is this
 * one: it is addressed to the model, phrased for the model, and carries option ids.
 *
 * Dropped from the transcript only. The turn stays in the session log and stays visible in the
 * Conversation tab, so "what was the agent actually told" is still answerable — this hides a
 * repetition in the one view where the thing it repeats is on screen.
 */
function isWidgetAnswerEcho(channel: TranscriptChannel, text: string): boolean {
  return channel === "user" && text.trimStart().startsWith(WIDGET_ANSWER_PREFIX);
}

function fromPersisted(e: SessionEventDto): Normalised | null {
  const p = e.payload;
  switch (p.kind) {
    case "assistant_turn":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: { kind: "text", channel: p.thinking ? "thinking" : "assistant", text: p.text },
      };
    case "user_turn":
      if (isWidgetAnswerEcho("user", p.text)) return null;
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: { kind: "text", channel: "user", text: p.text },
      };
    case "notice":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: { kind: "text", channel: "system", text: p.text },
      };
    case "tool_call":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "tool_call",
          name: p.name,
          callId: p.callId,
          input: p.input ?? null,
          status: p.status ?? null,
        },
      };
    case "tool_result":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "tool_result",
          callId: p.callId,
          ok: p.ok,
          output: p.output ?? null,
          truncated: p.truncated ?? false,
        },
      };
    case "permission_request":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "permission_request",
          requestId: p.requestId,
          title: p.title,
          toolKind: p.toolKind,
          toolCallId: p.toolCallId ?? null,
          options: p.options,
        },
      };
    case "permission_resolved":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "permission_resolved",
          requestId: p.requestId,
          optionId: p.optionId,
          decidedBy: p.decidedBy,
        },
      };
    case "widget":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: { kind: "widget", widgetId: p.widgetId, widget: p.widget },
      };
    case "widget_response":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "widget_response",
          widgetId: p.widgetId,
          values: p.values,
          text: p.text ?? null,
        },
      };
    // `usage`, `state`, `diff` and `todos` are records the transcript does not narrate: usage has
    // its own panel, state is the header's badge, a diff is the Changes tab, and the agent's plan
    // is the Plan panel beside it.
    default:
      return null;
  }
}

function fromLive(e: TaskEvent): Normalised | null {
  switch (e.kind) {
    case "stdout":
      if (isWidgetAnswerEcho(e.channel, e.text)) return null;
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: { kind: "text", channel: e.channel, text: e.text },
      };
    case "tool_use":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "tool_call",
          name: e.name,
          callId: e.callId,
          input: e.input,
          status: e.status,
        },
      };
    case "tool_result":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "tool_result",
          callId: e.callId,
          ok: e.ok,
          output: e.output,
          truncated: e.truncated,
        },
      };
    case "permission_request":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "permission_request",
          requestId: e.requestId,
          title: e.title,
          toolKind: e.toolKind,
          toolCallId: e.toolCallId,
          options: e.options,
        },
      };
    case "permission_resolved":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "permission_resolved",
          requestId: e.requestId,
          optionId: e.optionId,
          decidedBy: e.decidedBy,
        },
      };
    case "widget":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: { kind: "widget", widgetId: e.widgetId, widget: e.widget },
      };
    case "widget_response":
      return {
        sessionId: e.sessionId,
        seq: e.seq,
        payload: {
          kind: "widget_response",
          widgetId: e.widgetId,
          values: e.values,
          text: e.text,
        },
      };
    // `status` is the Task's own state and `diff` belongs to the Changes tab.
    default:
      return null;
  }
}

/**
 * Build the transcript.
 *
 * `live` is appended after `persisted` and deduplicated against it, so an event the socket
 * replayed and the query also returned appears once. Ordering is by session, then by `seq`
 * within it — `seq` restarts per session, so sorting on it globally would interleave review
 * rounds.
 */
export function buildTranscript(
  persisted: readonly SessionEventDto[],
  live: readonly TaskEvent[],
): TranscriptRow[] {
  const seen = new Set<string>();
  const normalised: Normalised[] = [];
  const sessionOrder: string[] = [];

  const take = (n: Normalised | null) => {
    if (!n) return;
    const key = `${n.sessionId}:${n.seq}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!sessionOrder.includes(n.sessionId)) sessionOrder.push(n.sessionId);
    normalised.push(n);
  };

  // Persisted first, so it wins the dedup: it is the copy that survived the database.
  for (const e of persisted) take(fromPersisted(e));
  for (const e of live) take(fromLive(e));

  const rank = new Map(sessionOrder.map((id, i) => [id, i]));
  normalised.sort(
    (a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0) || a.seq - b.seq,
  );

  const rows: TranscriptRow[] = [];
  // Correlation keyed on `(sessionId, callId)`, never `callId` alone: ids restart per session,
  // so a bare id would fold two unrelated calls from different review rounds into one row.
  const toolByCall = new Map<string, ToolRow>();
  const permissionByRequest = new Map<string, PermissionRow>();
  const widgetById = new Map<string, WidgetRow>();

  for (const n of normalised) {
    const id = `${n.sessionId}:${n.seq}`;
    const p = n.payload;

    if (p.kind === "text") {
      const last = rows[rows.length - 1];
      // Merge only into the immediately preceding block of the same channel and session. A tool
      // call or a user turn between two chunks ends the block, which is what keeps a turn from
      // absorbing whatever interrupted it.
      if (last?.kind === "text" && last.channel === p.channel && last.sessionId === n.sessionId) {
        last.text += p.text;
        last.seq = n.seq;
        continue;
      }
      rows.push({
        kind: "text",
        id,
        sessionId: n.sessionId,
        seq: n.seq,
        channel: p.channel,
        text: p.text,
        open: true,
      });
      continue;
    }

    if (p.kind === "widget") {
      const row: WidgetRow = {
        kind: "widget",
        id,
        sessionId: n.sessionId,
        seq: n.seq,
        widgetId: p.widgetId,
        widget: p.widget,
        response: null,
      };
      widgetById.set(`${n.sessionId}:${p.widgetId}`, row);
      rows.push(row);
      continue;
    }

    if (p.kind === "widget_response") {
      const widget = widgetById.get(`${n.sessionId}:${p.widgetId}`);
      // A response whose widget was compacted away is dropped rather than shown alone: unlike a
      // tool result, "someone answered something" says nothing without the question.
      if (widget) widget.response = { values: p.values, text: p.text };
      continue;
    }

    if (p.kind === "tool_call") {
      const existing = p.callId ? toolByCall.get(`${n.sessionId}:${p.callId}`) : undefined;
      if (existing) {
        // A `tool_call_update` — same call, new status. Not a second call.
        existing.status = p.status ?? existing.status;
        if (p.input) existing.input = p.input;
        continue;
      }
      const row: ToolRow = {
        kind: "tool",
        id,
        sessionId: n.sessionId,
        seq: n.seq,
        name: p.name,
        callId: p.callId,
        input: p.input,
        status: p.status,
        result: null,
      };
      // A call with no id cannot be correlated, so it stays its own row rather than being folded
      // into an unrelated one. That is the Claude Code path for any adapter that reports no id.
      if (p.callId) toolByCall.set(`${n.sessionId}:${p.callId}`, row);
      rows.push(row);
      continue;
    }

    if (p.kind === "tool_result") {
      const call = p.callId ? toolByCall.get(`${n.sessionId}:${p.callId}`) : undefined;
      if (call) {
        call.result = { ok: p.ok, output: p.output, truncated: p.truncated };
        call.status = p.ok ? "completed" : "failed";
        continue;
      }
      // A result whose call was compacted away, or that arrived first. Shown on its own rather
      // than dropped: "a tool failed" is worth reading even without the call beside it.
      rows.push({
        kind: "tool",
        id,
        sessionId: n.sessionId,
        seq: n.seq,
        name: "tool",
        callId: p.callId,
        input: null,
        status: p.ok ? "completed" : "failed",
        result: { ok: p.ok, output: p.output, truncated: p.truncated },
      });
      continue;
    }

    if (p.kind === "permission_request") {
      const key = `${n.sessionId}:${p.requestId}`;
      if (permissionByRequest.has(key)) continue;
      const row: PermissionRow = {
        kind: "permission",
        id,
        sessionId: n.sessionId,
        seq: n.seq,
        requestId: p.requestId,
        title: p.title,
        toolKind: p.toolKind,
        toolCallId: p.toolCallId,
        options: p.options,
        resolution: null,
      };
      permissionByRequest.set(key, row);
      rows.push(row);
      continue;
    }

    // permission_resolved: settles the question in place, so the widget stops being interactive
    // and the transcript still records what was asked and what was answered.
    const open = permissionByRequest.get(`${n.sessionId}:${p.requestId}`);
    if (open) {
      open.resolution = { optionId: p.optionId, decidedBy: p.decidedBy };
      continue;
    }
    rows.push({
      kind: "notice",
      id,
      sessionId: n.sessionId,
      seq: n.seq,
      text: `Permission ${p.optionId ?? "declined"} (${p.decidedBy})`,
    });
  }

  // Every block except the last of its channel is settled — nothing more can be appended to it,
  // so a renderer may parse and memoize it. Only the tail is still growing.
  const lastTextIndex = rows.reduce((found, row, i) => (row.kind === "text" ? i : found), -1);
  for (const [i, row] of rows.entries()) {
    if (row.kind === "text") row.open = i === lastTextIndex;
  }

  return rows;
}

/** The permission still awaiting an answer, if any — what makes the widget interactive. */
/**
 * Whether the fences in a block are all closed.
 *
 * The tail of a live turn is rendered as plain text because a fence that has only half arrived
 * would, parsed as markdown, swallow everything after it — and re-parse into something different
 * on the next chunk. That rule was applied to the whole tail, and the cost was this: an agent
 * whose last turn *ends* in a closed code block — the summary, the diff, the requirements file it
 * just wrote — showed the reader raw backticks for as long as the run stayed alive, which for a
 * run waiting on an answer is indefinitely.
 *
 * Counting the fences separates the two cases exactly. An even count means every fence that was
 * opened was closed, so the block can be parsed with no risk of a runaway; an odd count means the
 * agent is mid-block and plain text is still the honest rendering.
 */
export function fencesBalanced(text: string): boolean {
  let count = 0;
  let at = text.indexOf("```");
  while (at !== -1) {
    count += 1;
    at = text.indexOf("```", at + 3);
  }
  return count % 2 === 0;
}

export function openPermission(rows: readonly TranscriptRow[]): PermissionRow | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.kind === "permission" && row.resolution === null) return row;
  }
  return null;
}

/**
 * What the agent appears to be doing right now.
 *
 * A running agent is silent for long stretches — a launch takes seconds to reach the first
 * token, a `Bash` call can take a minute, and a thinking block streams nothing the operator was
 * meant to read. During any of those the panel showed a settled transcript and nothing else,
 * which is indistinguishable from a run that has hung. This is the difference, derived from the
 * rows rather than tracked in state so a reconnect cannot leave it stuck saying "launching" about
 * an agent that is already writing.
 *
 * `null` twice, and both times on purpose. Not running: there is nothing to report and a line
 * saying so would be noise under every finished run. Blocked on a question: the permission card
 * or the widget already says what is happening, and "thinking" underneath it would be a lie —
 * the agent is not thinking, it is waiting for the operator.
 */
export type AgentActivity =
  | { kind: "launching" }
  | { kind: "thinking" }
  | { kind: "tool"; name: string }
  | { kind: "writing" };

export function agentActivity(
  rows: readonly TranscriptRow[],
  isRunning: boolean,
): AgentActivity | null {
  if (!isRunning) return null;
  // Nothing has arrived yet: the orchestrator is still starting the session and checking out the
  // worktree. This is the window the operator most needs a word for — they pressed Launch and
  // the panel has not changed since.
  if (rows.length === 0) return { kind: "launching" };
  if (rows.some(awaitingOperator)) return null;

  const last = rows[rows.length - 1];
  // A call is in flight when nothing has come back from it. Read off the *result* rather than off
  // `status`, which is null for every adapter that reports no progress at all — Claude Code among
  // them — and would have left the longest tool calls in the product looking like dead air.
  if (last?.kind === "tool" && last.result === null && !settled(last.status)) {
    return { kind: "tool", name: last.name };
  }
  if (last?.kind === "text" && last.open && last.channel === "assistant") {
    return { kind: "writing" };
  }
  // Everything else — a thinking block still arriving, a finished tool call, a settled turn the
  // agent has not followed up yet — is the model working with nothing to show for it.
  return { kind: "thinking" };
}

/** Whether a tool call reported its own end, for the adapters that report one. */
function settled(status: ToolRow["status"]): boolean {
  return status === "completed" || status === "failed";
}

/** A question the run is stopped on until somebody answers it. */
function awaitingOperator(row: TranscriptRow): boolean {
  if (row.kind === "permission") return row.resolution === null;
  return row.kind === "widget" && row.response === null;
}
