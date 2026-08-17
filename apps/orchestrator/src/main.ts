/// <reference types="bun-types" />
import { functions, startWebSocketServer } from "./index.js";

/**
 * Orchestrator entrypoint (Decision 0002). Starts the long-lived WebSocket hub. The Inngest
 * functions are exported for a separate Inngest serve handler; wiring that HTTP endpoint is a
 * Phase 3 follow-up (the durable engine runs the `functions` below).
 */
const server = startWebSocketServer();
console.log(`[gatecontrol/orchestrator] WebSocket hub listening on :${server.port}`);
console.log(`[gatecontrol/orchestrator] ${functions.length} Inngest function(s) registered`);
