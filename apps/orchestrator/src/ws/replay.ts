import type { SessionEventPayload, TaskEvent } from "@solow/contracts";
import { describeWorkflowDecision } from "@solow/core";
import type { StreamTicketClaims } from "@solow/core/stream";
import type { Db } from "@solow/db";
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
 * `usage` and `state` are durable records nothing streams: usage belongs to `session_usage`, and
 * the board's `status` frame already carries a transition.
 *
 * This used to say the wire union was "deliberately not extended here", and to collapse
 * `assistant_turn` / `user_turn` / `notice` into one `stdout` frame with thinking encoded as a
 * literal "· " prefix. That made the four kinds indistinguishable to any client and left
 * `tool_result` with no wire form at all, so a live terminal could not tell the operator's own
 * steering from the model's answer, could not correlate a tool call with its result, and could
 * not render markdown for prose without also mangling machine output. The wire now carries what
 * the log stores; the terminal decides how it looks.
 *
 * `workflowStepId` is the row's own column, passed in rather than dug out of the payload: only
 * `workflow_decision` carries a Step id inside its payload, so a projection that read it from
 * there would attribute one kind of frame out of nine and leave the rest unsegmentable. It is
 * written onto every frame the log produces, `null` included — the orchestrator saying "this ran
 * under no Step", which is a different claim from the field being absent because the producer
 * predates the column.
 */
export function toTaskEvent(
  payload: SessionEventPayload,
  taskId: string,
  sessionId: string,
  seq: number,
  workflowStepId: string | null,
): TaskEvent | null {
  switch (payload.kind) {
    case "assistant_turn":
      return {
        kind: "stdout",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        text: payload.text,
        channel: payload.thinking ? "thinking" : "assistant",
      };
    case "user_turn":
      return {
        kind: "stdout",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        text: payload.text,
        channel: "user",
      };
    case "notice":
      return {
        kind: "stdout",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        text: payload.text,
        channel: "system",
      };
    case "tool_call":
      return {
        kind: "tool_use",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        name: payload.name,
        callId: payload.callId,
        input: payload.input ?? null,
        status: payload.status ?? null,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        callId: payload.callId,
        ok: payload.ok,
        output: payload.output ?? null,
        truncated: payload.truncated ?? false,
      };
    case "diff":
      return { kind: "diff", taskId, workflowStepId, sessionId, diffRef: payload.diffRef };
    case "permission_request":
      // Replayed as itself rather than degraded to a stdout line: a reconnecting operator has to
      // still be able to answer the question, not merely read that it was asked.
      return {
        kind: "permission_request",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        requestId: payload.requestId,
        title: payload.title,
        toolKind: payload.toolKind,
        toolCallId: payload.toolCallId ?? null,
        options: payload.options,
      };
    case "permission_resolved":
      return {
        kind: "permission_resolved",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        requestId: payload.requestId,
        optionId: payload.optionId,
        decidedBy: payload.decidedBy,
      };
    case "widget":
      return {
        kind: "widget",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        widgetId: payload.widgetId,
        widget: payload.widget,
      };
    case "todos":
      // Replayed like any other row: the list is stored whole on every rewrite, so a client
      // that reconnects mid-run rebuilds the plan by keeping the last of these it sees.
      return { kind: "todos", taskId, workflowStepId, sessionId, seq, items: payload.items };
    case "workflow_decision":
      // A machine line in the transcript, in the same place and voice as every other notice
      // about the run — composed once, in core, so the live frame and the replayed one read
      // identically. The structured record stays in the log for a reader that wants the facts.
      //
      // Still flattened, deliberately. The reason to stop would have been that the Step id lives
      // inside the payload and a `stdout` frame drops it — but the id now travels in the column
      // beside every frame, so the decision segments with the rest of the transcript without the
      // wire union growing a variant whose only new information is a sentence this already says.
      // Which Step it lands under is the Step the decision is *about*, not the one it advances
      // to, so "step 2 finished, moving to step 3" closes step 2's transcript rather than opening
      // step 3's with news about work the reader has not seen yet.
      return {
        kind: "stdout",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        text: describeWorkflowDecision(payload),
        channel: "system",
      };
    case "widget_response":
      return {
        kind: "widget_response",
        taskId,
        workflowStepId,
        sessionId,
        seq,
        widgetId: payload.widgetId,
        values: payload.values,
        text: payload.text ?? null,
      };
    case "usage":
    case "state":
    // `agent_done` has no wire form on purpose. It is a durable marker for the reclaim sweep —
    // "the harness finished, here is its branch" — and every consequence a client cares about
    // reaches it as the `status` change that follows. Replaying it would put a row in the
    // transcript saying the run ended, immediately above the state change saying the same thing.
    case "agent_done":
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
      const frame = toTaskEvent(
        e.payload,
        data.claims.taskId,
        e.sessionId,
        e.seq,
        e.workflowStepId,
      );
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
