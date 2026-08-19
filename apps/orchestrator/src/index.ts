/// <reference types="bun-types" />
import { type TaskEvent, taskInputSchema } from "@gatecontrol/contracts";
import {
  type StreamTicketClaims,
  streamChannel,
  verifyStreamTicket,
} from "@gatecontrol/core/stream";
import { createDb, type Db } from "@gatecontrol/db";
import { type AgentRegistry, agentRegistry } from "./agent/registry.js";
import { listTaskEventsSince } from "./data.js";
import { orchestratorEnv } from "./env.js";
import { inngest } from "./inngest/client.js";
import { taskRun } from "./inngest/functions/task-run.js";
import { hub } from "./ws/hub.js";

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
 * Replay what the client missed, then hand back the live subscription. Live events that arrive
 * mid-replay are buffered and flushed afterwards (dropping any the replay already covered), so
 * a reconnect never loses or reorders terminal history.
 */
export async function attachSubscriber(
  deps: Pick<WsServerDeps, "db">,
  data: Omit<WsData, "unsubscribe">,
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
      send(toTaskEvent(e.kind, e.payload, data.claims.taskId, e.sessionId, e.seq));
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
): Promise<{ ok: true; action: "input" | "stop" } | { ok: false; error: ClientFrameError }> {
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
  const accepted = await deps.registry.send(claims.workspaceId, frame.taskId, frame.data);
  return accepted ? { ok: true, action: "input" } : { ok: false, error: "agent_not_running" };
}

export type ClientFrameError = "frame_malformed" | "frame_not_authorized" | "agent_not_running";

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

/** Rebuild a wire event from a stored log row. Unknown kinds degrade to a stdout line. */
function toTaskEvent(
  kind: string,
  payload: unknown,
  taskId: string,
  sessionId: string,
  seq: number,
): TaskEvent {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (kind === "tool_use") {
    return { kind: "tool_use", taskId, sessionId, seq, name: String(p["name"] ?? "") };
  }
  if (kind === "diff") {
    return { kind: "diff", taskId, sessionId, diffRef: String(p["diffRef"] ?? "") };
  }
  return { kind: "stdout", taskId, sessionId, seq, text: String(p["text"] ?? "") };
}

/**
 * Long-lived orchestrator process (Decision 0002): hosts the WebSocket hub and the Inngest
 * functions. Serverless-style Next.js cannot hold these, so they run here.
 */
export function startWebSocketServer(
  port = orchestratorEnv().GATECONTROL_WS_PORT,
  deps: WsServerDeps = defaultWsDeps(),
) {
  return Bun.serve<WsData>({
    port,
    fetch(req, server) {
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
