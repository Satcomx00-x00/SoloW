/// <reference types="bun-types" />
import type { FailureSignal } from "@gatecontrol/core";

/**
 * Agent runner (spec F04 / task TASK-014). GateControl drives an external coding-agent CLI
 * (Claude Code) over ACP. This interface keeps orchestration independent of the concrete
 * agent/transport; `AcpAgentRunner` is the real implementation and `FakeAgentRunner` the
 * deterministic one the lifecycle tests drive.
 *
 * Credential-isolation note (finding C1): `env` carries only the single credential shaped by
 * the billing guard; the orchestrator's secret store is never exposed to the agent process.
 */
export type AgentStreamEvent =
  | { kind: "stdout"; text: string }
  | { kind: "tool_use"; name: string };

export type AgentOutcome = { kind: "completed" } | { kind: "failed"; signal: FailureSignal };

export interface AgentStartOpts {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** What the agent is asked to do this round — the Task brief, plus any review feedback. */
  prompt: string;
  onEvent: (e: AgentStreamEvent) => void;
}

export interface AgentHandle {
  outcome: Promise<AgentOutcome>;
  /**
   * Operator input from the review terminal (TASK-022). ACP has no "type into a running turn",
   * so the text is queued and sent as the next prompt turn once the current one ends. Resolves
   * `false` when the run is already finishing and the input could not be accepted.
   */
  send(text: string): Promise<boolean>;
  stop(): Promise<void>;
}

export interface AgentRunner {
  start(opts: AgentStartOpts): AgentHandle;
}

/** Deterministic runner for tests: emits scripted events then completes. */
export class FakeAgentRunner implements AgentRunner {
  /** Prompts the lifecycle sent, in order — assert on these to check what the agent was told. */
  readonly prompts: string[] = [];
  /** Operator input that reached the agent. */
  readonly inputs: string[] = [];
  stopped = false;

  constructor(private readonly script: AgentStreamEvent[] = [{ kind: "stdout", text: "ok" }]) {}

  start(opts: AgentStartOpts): AgentHandle {
    this.prompts.push(opts.prompt);
    for (const e of this.script) opts.onEvent(e);
    return {
      outcome: Promise.resolve<AgentOutcome>({ kind: "completed" }),
      send: async (text: string) => {
        this.inputs.push(text);
        opts.onEvent({ kind: "stdout", text });
        return true;
      },
      stop: async () => {
        this.stopped = true;
      },
    };
  }
}
