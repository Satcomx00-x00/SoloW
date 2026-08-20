/**
 * Agent Client Protocol client (Decision 0003 / issue #58).
 *
 * GateControl is the *client* in ACP's terms: it starts the agent, negotiates what the agent can
 * do, gives it work, watches it, answers the permissions it asks for, and cancels it. The
 * package is split so the protocol half is testable without a process — `jsonrpc.ts` is framing,
 * `protocol.ts` is vocabulary, `capabilities.ts` is negotiation, and only `session.ts` needs a
 * child. None of them spawns one: the caller injects `SpawnFn`, which keeps exactly one module
 * in the product allowed to reach the execution host.
 */
export {
  ACP_MIN_PROTOCOL_VERSION,
  ACP_PROTOCOL_VERSION,
  type AcpCapability,
  assertPromptBlocks,
  CapabilityUnavailableError,
  GATECONTROL_CLIENT_CAPABILITIES,
  initializeParams,
  type NegotiatedCapabilities,
  negotiate,
  ProtocolVersionError,
  requireCapability,
} from "./capabilities.js";
export {
  encodeMessage,
  JsonRpcError,
  JsonRpcErrorCode,
  type JsonRpcMessage,
  JsonRpcPeer,
  parseJsonRpcMessage,
} from "./jsonrpc.js";
export {
  AcpMethod,
  type AcpPermissionOption,
  type AcpUpdate,
  textPrompt,
  toUpdates,
} from "./protocol.js";
export {
  ACP_CANCEL_GRACE_MS,
  ACP_EXIT_GRACE_MS,
  ACP_HANDSHAKE_GRACE_MS,
  ACP_KILL_GRACE_MS,
  type AcpOutcome,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpSession,
  type AcpSessionOptions,
  type ChildProcessHandle,
  type SpawnFn,
  startAcpSession,
} from "./session.js";
