import type { AgentProtocol } from "@gatecontrol/contracts";

/**
 * Which agent protocols this orchestrator can actually drive (issue #10).
 *
 * The catalog can describe an agent by any protocol in `AgentProtocol` — that is what makes
 * adding an agent a data row instead of a code change. But describing a protocol is not
 * implementing one: today only Claude Code's own stream-JSON protocol has a runner behind it
 * (`ClaudeCodeRunner`). `acp` (#58) and `cli_passthrough` (#21) are real members of the enum,
 * named ahead of their drivers on purpose, the same way #73 named `docker`/`ssh`/`cloud`
 * Executor kinds before those drivers existed.
 *
 * Without this check, an Agent Profile pointing at an undriven protocol would either crash
 * deep inside the runner or — worse — silently fall through to whatever the runner happens to
 * do by default. Failing the Task before an agent starts, with the reason named, is the honest
 * answer.
 */
export const AVAILABLE_AGENT_PROTOCOLS: readonly AgentProtocol[] = ["claude_code_stream_json"];

export function hasAgentRunner(protocol: AgentProtocol): boolean {
  return AVAILABLE_AGENT_PROTOCOLS.includes(protocol);
}

export function missingAgentRunnerReason(protocol: AgentProtocol): string {
  return `no agent runner for protocol "${protocol}" — this GateControl build can only drive ${AVAILABLE_AGENT_PROTOCOLS.join(", ")}`;
}
