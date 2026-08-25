/// <reference types="bun-types" />
import { announceRequest, taskInputSchema } from "@gatecontrol/contracts";
import {
  type StreamTicketClaims,
  streamChannel,
  verifyStreamTicket,
} from "@gatecontrol/core/stream";
import { createDb, type Db } from "@gatecontrol/db";
import {
  type AgentRegistry,
  agentRegistry,
  type PermissionAnswerResult,
  type WidgetAnswerResult,
} from "./agent/registry.js";
import { orchestratorEnv } from "./env.js";
import { inngest } from "./inngest/client.js";
import { handleEventPost } from "./inngest/events.js";
import { taskRun } from "./inngest/functions/task-run.js";
import { inngestServeHandler } from "./inngest/serve.js";
import { reclaimOrphanedRuns } from "./reconcile.js";
import { hub } from "./ws/hub.js";
import { attachSubscriber } from "./ws/replay.js";

export { inngest };
export const functions = [taskRun];

interface WsData {
  claims: StreamTicketClaims;
  channel: string;
  /** Last `seq` the client already has; replay resumes just after it. */
  since: number;
  unsubscribe?: () => void;
}

/** Collaborators the WS server needs, injectable so the auth/replay paths are testable. */
export interface WsServerDeps {
  db: Db;
  now: () => number;
  streamSecret: string;
  /** Where a client's input or stop is routed — the agent running that Task, if any. */
  registry: AgentRegistry;
}

function defaultWsDeps(): WsServerDeps {
  return {
    db: createDb(),
    now: () => Date.now(),
    streamSecret: orchestratorEnv().GATECONTROL_STREAM_SECRET,
    registry: agentRegistry,
  };
}

/**
 * Authorize an upgrade request (TASK-018). The connection carries a short-lived ticket the web
 * API signed after checking the session and Workspace ownership. The channel is derived from
 * the ticket's own claims — a client cannot name one — so a subscriber can only ever read its
 * own Workspace's stream (Principle V).
 */
export function authorizeUpgrade(
  url: string,
  deps: Pick<WsServerDeps, "now" | "streamSecret">,
): { ok: true; data: Omit<WsData, "unsubscribe"> } | { ok: false; status: number; error: string } {
  const params = new URL(url).searchParams;
  const ticket = params.get("ticket");
  if (!ticket) return { ok: false, status: 401, error: "ticket_required" };

  const verified = verifyStreamTicket(ticket, deps.streamSecret, deps.now());
  if (!verified.ok) return { ok: false, status: 401, error: verified.error };

  const sinceRaw = Number(params.get("since") ?? "-1");
  const since = Number.isFinite(sinceRaw) ? Math.trunc(sinceRaw) : -1;
  return {
    ok: true,
    data: { claims: verified.claims, channel: streamChannel(verified.claims), since },
  };
}

/**
 * Tell every client watching that a Task changed, when the change was made by the API rather
 * than by a run.
 *
 * The hub lives in this process and the web app does not, so a state change made by a person —
 * moving a card, opening the review gate, retrying — reached only the browser that made it. Its
 * own client refetched and every other one sat on a stale board until someone reloaded, which is
 * exactly the "I have to refresh" this endpoint removes.
 *
 * Authorised by the same signed ticket the WebSocket upgrade takes, and the Workspace and Task
 * are read from the ticket's *claims* — never from the body, so a caller cannot announce into
 * another tenant's channel (Principle V). It publishes and nothing else: no state is written
 * here, because the API already wrote it. This is the notification, not the change.
 */
export async function handleAnnouncePost(
  req: Request,
  deps: Pick<WsServerDeps, "now" | "streamSecret">,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid_json", { status: 400 });
  }
  const parsed = announceRequest.safeParse(body);
  if (!parsed.success) return new Response("invalid_request", { status: 400 });

  const verified = verifyStreamTicket(parsed.data.ticket, deps.streamSecret, deps.now());
  if (!verified.ok) return new Response(verified.error, { status: 401 });
  const { workspaceId, taskId } = verified.claims;
  // A board-scoped ticket names no Task, and there is no Task-shaped news to publish without
  // one. Refused rather than broadcast, so the frame's `taskId` is always a real Task.
  if (!taskId) return new Response("task_ticket_required", { status: 400 });

  const message = {
    kind: "status" as const,
    taskId,
    state: parsed.data.state,
    at: new Date(deps.now()).toISOString(),
  };
  hub.publish(hub.boardChannel(workspaceId), message);
  hub.publish(hub.taskChannel(workspaceId, taskId), message);
  return new Response(null, { status: 202 });
}

/**
 * Reconnect replay and the stored-event → wire-frame projection now live in `ws/replay.ts`, so
 * the live publish path in `task-run.ts` and this one share a single projection instead of two
 * hand-kept-in-sync copies (issue #2, AC-5). Re-exported here because this is the module the
 * WebSocket server and its tests already reach for.
 */
export { attachSubscriber };

/**
 * Route a client frame to the agent running that Task (tasks TASK-014 / TASK-022).
 *
 * Tenancy: the Workspace comes from the subscriber's *signed ticket*, never from the frame, and
 * a frame naming a different Task than the ticket authorized is refused — so a client can only
 * ever steer the one agent it was granted (Principle V). A board-channel subscriber has no
 * `taskId` in its claims and therefore cannot steer anything.
 */
export async function handleClientFrame(
  deps: Pick<WsServerDeps, "registry">,
  claims: StreamTicketClaims,
  raw: unknown,
): Promise<
  | { ok: true; action: "input" | "stop" | "permission" | "widget_response" }
  | { ok: false; error: ClientFrameError }
> {
  const parsed = taskInputSchema.safeParse(safeJson(raw));
  if (!parsed.success) return { ok: false, error: "frame_malformed" };
  const frame = parsed.data;

  if (!claims.taskId || frame.taskId !== claims.taskId) {
    return { ok: false, error: "frame_not_authorized" };
  }

  if (frame.kind === "stop") {
    const stopped = await deps.registry.stop(claims.workspaceId, frame.taskId);
    return stopped ? { ok: true, action: "stop" } : { ok: false, error: "agent_not_running" };
  }
  if (frame.kind === "permission") {
    // The operator's answer to something the agent asked (issue #58, AC-4), routed the same way
    // as input and stop and under the same tenant key: a client can only ever answer for the
    // one agent its ticket authorized (Principle V).
    const answered = await deps.registry.respondPermission(
      claims.workspaceId,
      frame.taskId,
      frame.requestId,
      frame.optionId,
    );
    if (answered === "answered") return { ok: true, action: "permission" };
    // Four refusals, four things to say. An answer that arrived a moment after the deadline
    // settled the request must not be reported as an agent that is no longer running — the
    // agent is mid-turn, streaming into the terminal the operator is looking at.
    return { ok: false, error: PERMISSION_FRAME_ERROR[answered] };
  }
  if (frame.kind === "widget_response") {
    // The operator's answer to something the agent drew. Same route, same tenant key, same ack
    // shape as a permission — the two are the same act with different vocabulary.
    const answered = await deps.registry.respondWidget(claims.workspaceId, frame.taskId, {
      widgetId: frame.widgetId,
      values: frame.values,
      text: frame.text ?? null,
    });
    if (answered === "answered") return { ok: true, action: "widget_response" };
    return { ok: false, error: WIDGET_FRAME_ERROR[answered] };
  }
  const accepted = await deps.registry.send(claims.workspaceId, frame.taskId, frame.data);
  return accepted ? { ok: true, action: "input" } : { ok: false, error: "agent_not_running" };
}

export type ClientFrameError =
  | "frame_malformed"
  | "frame_not_authorized"
  | "agent_not_running"
  | "permission_not_pending"
  | "permission_option_unknown"
  | "permission_unsupported"
  | "widget_not_pending"
  | "widget_option_unknown";

/** Why a permission answer did not land, in the vocabulary the ack carries. */
const PERMISSION_FRAME_ERROR: Record<
  Exclude<PermissionAnswerResult, "answered">,
  ClientFrameError
> = {
  no_agent: "agent_not_running",
  no_permission_channel: "permission_unsupported",
  not_pending: "permission_not_pending",
  option_not_offered: "permission_option_unknown",
};

/**
 * Why a widget answer did not land. `no_widget_channel` reports as `agent_not_running` on
 * purpose: a run old enough to have no widget channel has no widget on screen either, so the
 * honest thing to tell the operator is that nothing is listening — not that their answer was
 * about the wrong option.
 */
const WIDGET_FRAME_ERROR: Record<Exclude<WidgetAnswerResult, "answered">, ClientFrameError> = {
  no_agent: "agent_not_running",
  no_widget_channel: "agent_not_running",
  not_pending: "widget_not_pending",
  option_unknown: "widget_option_unknown",
};

function safeJson(raw: unknown): unknown {
  const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? decodeUtf8(raw) : null;
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const decodeUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * How long to wait after boot before the first reclaim sweep (see `reconcile.ts`). Long enough
 * that a legitimate Inngest redrive — which re-registers with `agentRegistry` the moment it
 * resumes — has a real chance to land first.
 */
const RECONCILE_GRACE_MS = 20_000;

/**
 * How often to sweep after that.
 *
 * The sweep used to happen once, at boot, and that was the bug: it answers only "was something
 * orphaned by the process before me", never "has something been orphaned since". A run that died
 * two hours into a process left its Task showing `running`, with an input box answering "No agent
 * is running", until somebody restarted the orchestrator. Sweeping on a timer is what closes it.
 *
 * A minute is cheap — one indexed select over `running` Tasks, which is a handful of rows — and
 * the delay an Owner actually feels is dominated by `RECLAIM_STALE_MS`, the quiet period a Task
 * has to serve before this will touch it at all.
 */
const RECONCILE_INTERVAL_MS = 60_000;

/**
 * Long-lived orchestrator process (Decision 0002): hosts the WebSocket hub and the Inngest
 * functions. Serverless-style Next.js cannot hold these, so they run here.
 */
export function startWebSocketServer(
  port = orchestratorEnv().GATECONTROL_WS_PORT,
  deps: WsServerDeps = defaultWsDeps(),
) {
  // A failed sweep must never stop the next one: the reasons this throws (a locked database, a
  // transient driver error) are exactly the transient kind, and a net that retires on its first
  // stumble is the shape of the bug this schedule replaced.
  const sweep = () =>
    reclaimOrphanedRuns(deps.db, deps.registry, hub)
      .then((count) => {
        if (count > 0) {
          console.log(`[gatecontrol/orchestrator] reclaimed ${count} orphaned running task(s)`);
        }
      })
      .catch((cause) => {
        console.error("[gatecontrol/orchestrator] reconciliation sweep failed:", cause);
      });

  setTimeout(() => {
    void sweep();
    setInterval(() => void sweep(), RECONCILE_INTERVAL_MS);
  }, RECONCILE_GRACE_MS);

  return Bun.serve<WsData>({
    port,
    fetch(req, server) {
      const { pathname } = new URL(req.url);
      // The two HTTP routes the durable engine needs (Decision 0004), handled before the
      // upgrade check below so they never fall into the "websocket only" 426: `/events` is
      // where `orchestrator-client.ts`'s `emit()` lands, and `/api/inngest` is what the
      // Inngest Dev Server (or, hosted, Inngest Cloud) polls to discover and invoke `taskRun`.
      if (pathname === "/events" && req.method === "POST") return handleEventPost(req);
      if (pathname === "/api/inngest") return inngestServeHandler(req);
      if (pathname === "/announce" && req.method === "POST") return handleAnnouncePost(req, deps);

      const auth = authorizeUpgrade(req.url, deps);
      if (!auth.ok) return new Response(auth.error, { status: auth.status });
      if (server.upgrade(req, { data: auth.data })) return undefined;
      return new Response("websocket only", { status: 426 });
    },
    websocket: {
      async open(ws) {
        ws.data.unsubscribe = await attachSubscriber(deps, ws.data, (msg) =>
          ws.send(JSON.stringify(msg)),
        );
      },
      async message(ws, raw) {
        const result = await handleClientFrame(deps, ws.data.claims, raw);
        // Acknowledge either way: the terminal needs to tell the operator that their input
        // went nowhere (no agent running) rather than appear to have been accepted.
        ws.send(JSON.stringify({ kind: "ack", ...result }));
      },
      close(ws) {
        ws.data.unsubscribe?.();
      },
    },
  });
}
