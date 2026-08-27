/// <reference types="bun-types" />
import { functions, startWebSocketServer } from "./index.js";

/**
 * Orchestrator entrypoint (Decision 0002). One `Bun.serve` hosts three things on one port: the
 * WebSocket hub, `/events` (where the web app's `emit()` lands), and `/api/inngest` (what the
 * Inngest Dev Server — or, hosted, Inngest Cloud — polls to discover and invoke `functions`
 * below). All three routes live in `index.ts`; this file only starts the server and reports it.
 */
const server = startWebSocketServer();
console.log(`[solow/orchestrator] WebSocket hub listening on :${server.port}`);
console.log(`[solow/orchestrator] /events and /api/inngest live on :${server.port}`);
console.log(`[solow/orchestrator] ${functions.length} Inngest function(s) registered`);
