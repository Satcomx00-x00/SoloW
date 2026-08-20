import type { AgentProtocol } from "@gatecontrol/contracts";

/**
 * Which agent protocols this orchestrator can actually drive (issues #10 and #58).
 *
 * The catalog can describe an agent by any protocol in `AgentProtocol` — that is what makes
 * adding an agent a data row instead of a code change. But describing a protocol is not
 * implementing one. Two now have a driver behind them: `acp`, the standard boundary Decision
 * 0003 chose, and `claude_code_stream_json`, which survives as a first-class adapter rather
 * than being forced through ACP because subscription billing works through the vendor CLI's own
 * authentication (Decision 0005) and Claude Code's ACP bridge is a separate binary. Only
 * `cli_passthrough` (#21) is still named ahead of its driver, the same way #73 named the
 * `docker`/`ssh`/`cloud` Executor kinds before those drivers existed.
 *
 * Without this check, an Agent Profile pointing at an undriven protocol would either crash
 * deep inside the runner or — worse — silently fall through to whatever the runner happens to
 * do by default. Failing the Task before an agent starts, with the reason named, is the honest
 * answer.
 *
 * This list and `createAgentRunner`'s switch answer two halves of one question, so a test
 * asserts they agree for every member of the enum; they cannot drift apart unnoticed.
 */
export const AVAILABLE_AGENT_PROTOCOLS: readonly AgentProtocol[] = [
  "claude_code_stream_json",
  "acp",
];

export function hasAgentRunner(protocol: AgentProtocol): boolean {
  return AVAILABLE_AGENT_PROTOCOLS.includes(protocol);
}

export function missingAgentRunnerReason(protocol: AgentProtocol): string {
  return `no agent runner for protocol "${protocol}" — this GateControl build can only drive ${AVAILABLE_AGENT_PROTOCOLS.join(", ")}`;
}

/**
 * Whether the agent makes the Task's worktree itself, or GateControl has to.
 *
 * Claude Code does, via `--worktree`, and GateControl adopts whatever path it reports. ACP has
 * no equivalent: an ACP agent works in the `cwd` it is given, so the lifecycle must provision
 * the worktree first and point the agent at it. The isolation guarantee (Principle II) is the
 * same either way — only who creates the directory changes — which is why this is a one-line
 * question here rather than two lifecycles.
 */
export function agentCreatesOwnWorktree(protocol: AgentProtocol): boolean {
  return protocol === "claude_code_stream_json";
}
