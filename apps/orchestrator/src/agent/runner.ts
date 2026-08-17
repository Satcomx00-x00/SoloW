/// <reference types="bun-types" />
import type { FailureSignal } from "@gatecontrol/core";

/**
 * Agent runner (spec F04 / task TASK-014). GateControl drives an external coding-agent CLI
 * (Claude Code) over ACP. This interface keeps orchestration independent of the concrete
 * agent/transport; the ACP JSON-RPC handshake plugs into `SpawnAgentRunner`.
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
  onEvent: (e: AgentStreamEvent) => void;
}

export interface AgentHandle {
  outcome: Promise<AgentOutcome>;
  stop(): Promise<void>;
}

export interface AgentRunner {
  start(opts: AgentStartOpts): AgentHandle;
}

/** Spawns the agent CLI as a child process and streams its stdout. */
export class SpawnAgentRunner implements AgentRunner {
  start(opts: AgentStartOpts): AgentHandle {
    const proc = Bun.spawn([opts.command, ...opts.args], {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) {
        opts.onEvent({ kind: "stdout", text: decoder.decode(chunk) });
      }
    })();

    const outcome: Promise<AgentOutcome> = proc.exited.then((code) =>
      code === 0 ? { kind: "completed" } : { kind: "failed", signal: {} },
    );

    return {
      outcome,
      async stop() {
        proc.kill();
        await proc.exited;
      },
    };
  }
}

/** Deterministic runner for tests: emits scripted events then completes. */
export class FakeAgentRunner implements AgentRunner {
  constructor(private readonly script: AgentStreamEvent[] = [{ kind: "stdout", text: "ok" }]) {}
  start(opts: AgentStartOpts): AgentHandle {
    for (const e of this.script) opts.onEvent(e);
    return {
      outcome: Promise.resolve<AgentOutcome>({ kind: "completed" }),
      stop: async () => {},
    };
  }
}
