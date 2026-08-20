import type { SessionEventPayload, TaskEvent } from "@gatecontrol/contracts";
import type { StreamTicketClaims } from "@gatecontrol/core/stream";
import type { Db } from "@gatecontrol/db";
import { listTaskEventsSince } from "../data.js";
import { hub } from "./hub.js";

/**
 * The one place a stored session event becomes a wire frame (task TASK-018, issue #2 AC-5).
 *
 * The live path and the reconnect path used to project independently — `emit` in `task-run.ts`
 * spread its payload straight onto the socket, and this module rebuilt a frame from the row —
 * and they agreed only because someone kept them agreeing. Both now go through `toTaskEvent`,
 * so a client that reconnects sees exactly what it would have seen live, by construction rather
 * than by maintenance.
 */

/**
 * Project a log payload onto the wire, or `null` for a record that has no wire form.
 *
 * `usage`, `state` and `tool_result` are durable records nothing streams: usage belongs to
 * `session_usage`, the board's `status` frame already carries a transition, and no runner
 * reports tool results yet. `attachSubscriber` still advances its cursor past them, so a skipped
 * row cannot make a following live event look like a duplicate.
 *
 * The wire union is deliberately not extended here. It is the contract the SPA already speaks,
 * and issue #2 is about what the *log* records; widening both at once would have made AC-5 —
 * "reconnect replay delivers exactly the missed events, unchanged" — untestable.
 */
export function toTaskEvent(
  payload: SessionEventPayload,
  taskId: string,
  sessionId: string,
  seq: number,
): TaskEvent | null {
  switch (payload.kind) {
    case "assistant_turn":
      // Thinking is a property of the record; the "· " marker is presentation, applied on the
      // way out so the stored text stays clean for the readers that are not a terminal (#16, #84).
      return {
        kind: "stdout",
        taskId,
        sessionId,
        seq,
        text: payload.thinking ? `· ${payload.text}` : payload.text,
      };
    case "user_turn":
    case "notice":
      return { kind: "stdout", taskId, sessionId, seq, text: payload.text };
    case "tool_call":
      return { kind: "tool_use", taskId, sessionId, seq, name: payload.name };
    case "diff":
      return { kind: "diff", taskId, sessionId, diffRef: payload.diffRef };
    case "permission_request":
      // Replayed as itself rather than degraded to a stdout line: a reconnecting operator has to
      // still be able to answer the question, not merely read that it was asked.
      return {
        kind: "permission_request",
        taskId,
        sessionId,
        seq,
        requestId: payload.requestId,
        title: payload.title,
        toolKind: payload.toolKind,
        options: payload.options,
      };
    case "permission_resolved":
      return {
        kind: "permission_resolved",
        taskId,
        sessionId,
        seq,
        requestId: payload.requestId,
        optionId: payload.optionId,
        decidedBy: payload.decidedBy,
      };
    case "usage":
    case "state":
    case "tool_result":
      return null;
  }
}

interface SubscriberData {
  claims: StreamTicketClaims;
  channel: string;
  /** Last `seq` the client already has; replay resumes just after it. */
  since: number;
}

/**
 * Replay what the client missed, then hand back the live subscription. Live events that arrive
 * mid-replay are buffered and flushed afterwards (dropping any the replay already covered), so
 * a reconnect never loses or reorders terminal history.
 */
export async function attachSubscriber(
  deps: { db: Db },
  data: SubscriberData,
  send: (msg: TaskEvent) => void,
): Promise<() => void> {
  let replaying = true;
  let highestReplayed = data.since;
  const buffered: TaskEvent[] = [];

  const unsubscribe = hub.subscribe(data.channel, (msg: TaskEvent) => {
    if (replaying) buffered.push(msg);
    else send(msg);
  });

  if (data.claims.taskId) {
    const missed = await listTaskEventsSince(
      deps.db,
      data.claims.workspaceId,
      data.claims.taskId,
      data.since,
    );
    for (const e of missed) {
      const frame = toTaskEvent(e.payload, data.claims.taskId, e.sessionId, e.seq);
      if (frame) send(frame);
      // Advanced even for a record with no wire form, so the buffered-live flush below still
      // knows this seq is accounted for.
      highestReplayed = Math.max(highestReplayed, e.seq);
    }
  }

  replaying = false;
  for (const msg of buffered) {
    if ("seq" in msg && msg.seq <= highestReplayed) continue;
    send(msg);
  }
  return unsubscribe;
}
