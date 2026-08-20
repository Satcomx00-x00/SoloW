import {
  type ClaudeSession,
  type ClaudeUpdate,
  startClaudeSession,
} from "@gatecontrol/claude-code";
import { detectFailureSignal, type FailureSignal } from "@gatecontrol/core";
import type { Executor } from "../executor/types.js";
import type {
  AgentHandle,
  AgentOutcome,
  AgentRunner,
  AgentStartOpts,
  AgentStreamEvent,
} from "./runner.js";

/**
 * Claude Code as GateControl's agent (task TASK-014) — now one adapter among N (issue #58).
 *
 * ACP is the uniform boundary Decision 0003 chose, and `AcpRunner` implements it; this runner
 * stays a peer behind the same `AgentRunner` interface rather than being routed through ACP,
 * because subscription billing works through the vendor CLI's own authentication (Decision
 * 0005) and Claude Code's ACP bridge ships as a separate binary. Nothing below changed when the
 * ACP client landed, which is what AC-3's "no behaviour change" means in practice.
 *
 * The handle it returns has no `respondPermission`: the CLI decides permissions inside itself
 * (see `DEFAULT_PERMISSION_MODE`) and offers no channel to ask an operator on, so the method is
 * simply absent rather than present and always answering `false`.
 *
 * Runs the CLI in its headless stream-JSON mode and **always with `--worktree`**. That flag is
 * the concurrency story: several Tasks run against one repository at a time, and two agents
 * editing a single working tree would overwrite each other (Principle II). Because Claude Code
 * creates the worktree, GateControl does not — it adopts the path the session reports, and the
 * rest of the lifecycle (diff, commit on approve, discard on reject, cleanup) targets that.
 *
 * Turn model. The session stays open, so operator input from the review terminal is written
 * straight into it as another user turn — no queueing between turns, unlike ACP.
 */

/**
 * Permission mode for an unattended run.
 *
 * There is nobody watching to answer a per-tool prompt, and the agent is confined to a
 * disposable worktree whose contents reach the repository only through a recorded human review
 * (Principle I). So the review gate, not a prompt no one will see, is the safety boundary.
 * `acceptEdits` lets it edit inside its worktree while still refusing the genuinely dangerous
 * things `bypassPermissions` would wave through.
 *
 * The ACP path is where that changes: it has a request channel, so an operator watching the
 * stream can be asked (`acp-runner.ts`, AC-4). stream-json has no equivalent, so this constant
 * stays what it is.
 */
export const DEFAULT_PERMISSION_MODE = "acceptEdits";

/** The worktree name Claude Code is asked to create, traceable back to the Task. */
export function worktreeNameForTask(taskId: string): string {
  return `gatecontrol-task-${taskId}`;
}

export interface ClaudeCodeRunnerOptions {
  /** Where the CLI process actually runs — issue #1's `Executor`. */
  executor: Executor;
  permissionMode?: string;
  /** Diagnostics sink for the CLI's stderr. Never receives protocol traffic. */
  onStderr?: (text: string) => void;
}

export class ClaudeCodeRunner implements AgentRunner {
  constructor(private readonly options: ClaudeCodeRunnerOptions) {}

  start(opts: AgentStartOpts): AgentHandle {
    let session: (ClaudeSession & { stderrTail: () => string }) | undefined;
    let stopRequested = false;

    try {
      session = startClaudeSession(
        {
          command: opts.command,
          ...(opts.args.length > 0 ? { extraArgs: opts.args } : {}),
          cwd: opts.cwd,
          env: opts.env,
          spawn: (cmd, spawnOpts) => this.options.executor.spawn(cmd, spawnOpts),
          worktreeName: opts.worktreeName,
          permissionMode: this.options.permissionMode ?? DEFAULT_PERMISSION_MODE,
          onUpdate: (update) => {
            const event = toStreamEvent(update);
            if (event) opts.onEvent(event);
          },
          ...(this.options.onStderr ? { onStderr: this.options.onStderr } : {}),
        },
        opts.prompt,
      );
    } catch (cause) {
      // Spawning failed outright — a missing binary, usually. Fail the run rather than leave
      // the lifecycle waiting on a session that was never created.
      const signal = detectFailureSignal(cause instanceof Error ? cause.message : String(cause));
      return {
        outcome: Promise.resolve<AgentOutcome>({ kind: "failed", signal }),
        workspacePath: Promise.resolve(null),
        send: async () => false,
        stop: async () => {},
      };
    }

    const live = session;
    const outcome: Promise<AgentOutcome> = live.outcome.then((result) => {
      // A stop is an operator decision, not a fault: the partial work stays in the worktree and
      // goes to review like any other completed run (Principle I).
      if (stopRequested || result.ok) return { kind: "completed" };
      return { kind: "failed", signal: signalFor(result.subtype, live.stderrTail()) };
    });

    return {
      outcome,
      workspacePath: live.workspacePath,
      async send(text: string) {
        return live.send(text);
      },
      async stop() {
        stopRequested = true;
        await live.stop();
      },
    };
  }
}

/**
 * Classify a failed run. The CLI's own `result.subtype` is the better signal when it says
 * something useful; otherwise fall back to whatever it printed on stderr, which is where quota
 * and credential problems are reported in prose.
 */
function signalFor(subtype: string | null, stderrTail: string): FailureSignal {
  const fromSubtype = detectFailureSignal(subtype);
  if (fromSubtype.quotaExhausted || fromSubtype.credentialInvalid) return fromSubtype;
  return detectFailureSignal(stderrTail);
}

/** Map a Claude Code update onto the wire event the SPA terminal renders. */
export function toStreamEvent(update: ClaudeUpdate): AgentStreamEvent | null {
  switch (update.kind) {
    case "tool_use":
      return { kind: "tool_use", name: update.name };
    case "usage":
      return {
        kind: "usage",
        messageId: update.messageId,
        reported: update.reported,
        model: update.model,
        inputTokens: update.inputTokens,
        outputTokens: update.outputTokens,
        cacheReadTokens: update.cacheReadTokens,
        cacheWriteTokens: update.cacheWriteTokens,
      };
    case "text": {
      // Thinking is shown, marked, rather than dropped: a reviewer judging the work wants the
      // agent's reasoning, and hiding it would make the terminal disagree with the transcript.
      const prefix = update.channel === "thinking" ? "· " : "";
      return { kind: "stdout", text: `${prefix}${update.text}` };
    }
    case "result":
      return update.text ? { kind: "stdout", text: `\n${update.text}\n` } : null;
    // The session preamble is plumbing, not output; the worktree it carries is read elsewhere.
    case "session":
      return null;
  }
}
