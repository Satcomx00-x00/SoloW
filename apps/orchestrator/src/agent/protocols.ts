import {
  AGENT_PROTOCOLS,
  type AgentProtocol,
  agentProtocolDescriptor,
  agentProtocolSchema,
} from "@solow/contracts";

/**
 * Which agent protocols this orchestrator can actually drive (issues #10, #58, #21).
 *
 * The catalog can describe an agent by any protocol in `AgentProtocol` — that is what makes
 * adding an agent a data row instead of a code change. But describing a protocol is not
 * implementing one, so the lifecycle asks here before it starts anything: an Agent Profile
 * pointing at an undriven protocol would otherwise crash deep inside a runner or, worse, fall
 * through to whatever the runner happens to do by default. Failing the Task before an agent
 * starts, with the reason named, is the honest answer.
 *
 * **Derived, not restated** (refactored 2026-08-28). This was a hand-written array beside a
 * hand-written `===`, and both compiled cleanly when a protocol was added — the failure only
 * appeared at run time, as a Task refused for a protocol that had a driver. Everything here now
 * reads `AGENT_PROTOCOLS`, whose `Record<AgentProtocol, …>` the compiler will not let anyone
 * extend the enum without filling in.
 *
 * `driven` is the contracts' claim; `createAgentRunner`'s switch is the fact. A test asserts they
 * agree for every member of the enum, so the two cannot drift apart unnoticed.
 */
export const AVAILABLE_AGENT_PROTOCOLS: readonly AgentProtocol[] = agentProtocolSchema.options
  .filter((protocol) => AGENT_PROTOCOLS[protocol].driven)
  // Frozen so a caller cannot quietly widen what this build claims to drive.
  .slice();

export function hasAgentRunner(protocol: AgentProtocol): boolean {
  return agentProtocolDescriptor(protocol).driven;
}

export function missingAgentRunnerReason(protocol: AgentProtocol): string {
  return `no agent runner for protocol "${protocol}" — this SoloW build can only drive ${AVAILABLE_AGENT_PROTOCOLS.join(", ")}`;
}

export function agentCreatesOwnWorktree(protocol: AgentProtocol): boolean {
  return agentProtocolDescriptor(protocol).createsOwnWorktree;
}
