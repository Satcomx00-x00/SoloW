/// <reference types="bun-types" />
import type { FailureSignal } from "@gatecontrol/core";

/**
 * Agent runner (spec F04 / task TASK-014). GateControl drives an external coding-agent CLI —
 * Claude Code by default, over its headless stream-JSON mode. This interface keeps orchestration
 * independent of the concrete agent and transport; `ClaudeCodeRunner` is the real implementation
 * and `FakeAgentRunner` the deterministic one the lifecycle tests drive.
 *
 * Credential-isolation note (finding C1): `env` carries only the single credential shaped by
 * the billing guard; the orchestrator's secret store is never exposed to the agent process.
 */
export type AgentStreamEvent =
  | { kind: "stdout"; text: string }
  | { kind: "tool_use"; name: string }
  /** One completed turn's token usage (issue #14). Counts and model only — never content. */
  | {
      kind: "usage";
      /** The assistant turn this belongs to — the deduplication key. See events.ts. */
      messageId: string | null;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    };

export type AgentOutcome = { kind: "completed" } | { kind: "failed"; signal: FailureSignal };

export interface AgentStartOpts {
  command: string;
  args: string[];
  /**
   * The *repository* to run in, not a per-Task worktree.
   *
   * The agent creates its own worktree (`claude --worktree`), which is what lets several Tasks
   * share one repository safely. Pointing this at a worktree GateControl had already made would
   * nest one inside another and put the agent's edits somewhere nothing downstream reads.
   */
  cwd: string;
  env: Record<string, string>;
  /**
   * Name for the worktree the agent should create, or null to run in `cwd` as-is.
   *
   * A Task's first round passes a name and the agent creates the worktree. Later rounds — a
   * reviewer asking for changes — pass null and point `cwd` at the worktree that already
   * exists: asking for it again would either fail or branch a fresh one from the base ref,
   * throwing away everything the earlier round produced.
   */
  worktreeName: string | null;
  /** What the agent is asked to do this round — the Task brief, plus any review feedback. */
  prompt: string;
  onEvent: (e: AgentStreamEvent) => void;
}

export interface AgentHandle {
  outcome: Promise<AgentOutcome>;
  /**
   * The directory the agent is actually working in, once it says so.
   *
   * GateControl adopts this rather than assuming a path: the worktree is the agent's to create,
   * and every later step — diff, commit on approve, discard on reject, cleanup — has to act on
   * the real one. `null` means the agent never reported a workspace, which the lifecycle must
   * treat as a failure to isolate rather than carry on regardless.
   */
  workspacePath: Promise<string | null>;
  /**
   * Operator input from the review terminal (TASK-022), delivered as another turn. Resolves
   * `false` when the run has already finished and the input could not be accepted.
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
  /** Worktree names the lifecycle asked for — `null` on a resume round, which asks for none. */
  readonly worktreeNames: (string | null)[] = [];
  stopped = false;

  constructor(
    private readonly script: AgentStreamEvent[] = [{ kind: "stdout", text: "ok" }],
    /** The workspace the fake claims to be working in; defaults to the repository it was given. */
    private readonly workspace?: (opts: AgentStartOpts) => string | null,
  ) {}

  start(opts: AgentStartOpts): AgentHandle {
    this.prompts.push(opts.prompt);
    this.worktreeNames.push(opts.worktreeName);
    for (const e of this.script) opts.onEvent(e);
    return {
      outcome: Promise.resolve<AgentOutcome>({ kind: "completed" }),
      workspacePath: Promise.resolve<string | null>(
        this.workspace ? this.workspace(opts) : (opts.worktreeName ?? opts.cwd),
      ),
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
