/**
 * ACP client wrapper (plan §"Agent connection", task TASK-014). Everything GateControl needs to
 * drive an external coding agent over Agent Client Protocol, with the protocol half
 * (`session.ts`) separated from the process half (`spawn.ts`) so both can be tested alone.
 */

export type { RequestPermissionRequest, StopReason, Stream } from "@agentclientprotocol/sdk";
export {
  AcpSession,
  type AcpSessionOptions,
  type AcpUpdate,
  allowOncePolicy,
  type PermissionDecision,
  type PermissionPolicy,
  toUpdates,
} from "./session.js";
export { type SpawnAcpAgentOptions, type SpawnedAgent, spawnAcpAgent } from "./spawn.js";
