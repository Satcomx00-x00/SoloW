/// <reference types="bun-types" />
import type { TaskEvent } from "@gatecontrol/contracts";
import { orchestratorEnv } from "./env.js";
import { hub } from "./ws/hub.js";
import { inngest } from "./inngest/client.js";
import { taskRun } from "./inngest/functions/task-run.js";

export { inngest };
export const functions = [taskRun];

interface WsData {
  channel: string;
  unsubscribe?: () => void;
}

/**
 * Long-lived orchestrator process (Decision 0002): hosts the WebSocket hub and the Inngest
 * functions. Serverless-style Next.js cannot hold these, so they run here.
 */
export function startWebSocketServer(port = orchestratorEnv().GATECONTROL_WS_PORT) {
  return Bun.serve<WsData>({
    port,
    fetch(req, server) {
      const channel = new URL(req.url).searchParams.get("channel");
      if (!channel) return new Response("channel required", { status: 400 });
      // TODO(TASK-018 auth): authenticate the connection and verify the channel's
      // workspaceId matches the session before upgrading (Principle V).
      if (server.upgrade(req, { data: { channel } })) return undefined;
      return new Response("websocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.data.unsubscribe = hub.subscribe(ws.data.channel, (msg: TaskEvent) =>
          ws.send(JSON.stringify(msg)),
        );
      },
      message() {
        // TODO(TASK-014): route client input/steering to the agent process.
      },
      close(ws) {
        ws.data.unsubscribe?.();
      },
    },
  });
}
