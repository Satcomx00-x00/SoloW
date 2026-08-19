/// <reference types="bun-types" />
import { AcpSession, type AcpUpdate, spawnAcpAgent } from "@gatecontrol/acp";
import { detectFailureSignal, type FailureSignal } from "@gatecontrol/core";
import type {
  AgentHandle,
  AgentOutcome,
  AgentRunner,
  AgentStartOpts,
  AgentStreamEvent,
} from "./runner.js";

/**
 * The real agent runner (task TASK-014): spawns the agent CLI, speaks ACP to it, and turns its
 * `session/update` notifications into the events the lifecycle streams and persists.
 *
 * Turn model. ACP v1 has no mid-turn input, so a run is a sequence of prompt turns: the Task
 * brief is turn one, and anything the operator types in the review terminal becomes the next
 * turn (`send`). The run ends when a turn completes with nothing queued behind it — that is the
 * moment the Task moves to review.
 *
 * Stopping ends the run but is not a failure: the agent's partial work stays in the worktree and
 * the Task goes to review, because whether to keep it is a human's decision (Principle I).
 *
 * Failure signals. The agent reports quota exhaustion and a rejected credential in prose on
 * stderr, so stderr is retained (bounded) and classified when the run fails; without that a Task
 * that should park until the quota window resets would go to Failed instead (spec AC-013).
 */

/** How much stderr to keep for failure classification. Enough for a message, not a log file. */
const STDERR_TAIL_LIMIT = 8_192;

export interface AcpAgentRunnerOptions {
  /** Diagnostics sink for agent stderr. Never receives protocol traffic. */
  onStderr?: (text: string) => void;
}

export class AcpAgentRunner implements AgentRunner {
  constructor(private readonly options: AcpAgentRunnerOptions = {}) {}

  start(opts: AgentStartOpts): AgentHandle {
    let stderrTail = "";
    const agent = spawnAcpAgent({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      onStderr: (text) => {
        stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
        this.options.onStderr?.(text);
      },
    });

    /** Operator input waiting for the current turn to end. */
    const queued: string[] = [];
    let accepting = true;
    let stopRequested = false;
    let session: AcpSession | undefined;

    const outcome: Promise<AgentOutcome> = (async () => {
      try {
        session = await AcpSession.connect(agent.stream, {
          cwd: opts.cwd,
          onUpdate: (update) => opts.onEvent(toStreamEvent(update)),
          onPermission: (request, decision) =>
            opts.onEvent({
              kind: "tool_use",
              name: `${request.toolCall.title ?? "tool"} — ${
                decision.kind === "select" ? "permitted" : "refused"
              }`,
            }),
        });

        let next: string | undefined = opts.prompt;
        while (next !== undefined) {
          const stopReason = await session.prompt(next);
          if (stopReason !== "end_turn") {
            opts.onEvent({ kind: "stdout", text: `\n[agent stopped: ${stopReason}]\n` });
            break;
          }
          // No await between the shift and the loop test, so `send` cannot slip input in after
          // the run has decided it is finished.
          next = queued.shift();
        }
        accepting = false;
        return { kind: "completed" };
      } catch (cause) {
        accepting = false;
        // A stop is an operator decision, not a fault: the turn was torn down on purpose, and
        // the partial work in the worktree goes to review like any other completed run.
        if (stopRequested) return { kind: "completed" };
        // The agent explains a quota or credential failure on stderr, so read it before
        // classifying — a process that dies fast would otherwise always look like a plain
        // crash and park-on-quota would never fire. End the process first so the drain is
        // bounded even when the protocol failed while the agent was still alive.
        await agent.kill().catch(() => undefined);
        await agent.stderrDrained.catch(() => undefined);
        return { kind: "failed", signal: signalFor(cause, stderrTail) };
      } finally {
        accepting = false;
        session?.close();
        await agent.kill();
      }
    })();

    return {
      outcome,
      async send(text: string) {
        if (!accepting) return false;
        queued.push(text);
        return true;
      },
      async stop() {
        accepting = false;
        stopRequested = true;
        queued.length = 0;
        // Ask the agent to wind the turn down, then make sure the process is actually gone.
        await session?.cancel().catch(() => undefined);
        await agent.kill();
      },
    };
  }
}

/** Classify why a run died, preferring what the agent said on stderr over the thrown error. */
function signalFor(cause: unknown, stderrTail: string): FailureSignal {
  const fromStderr = detectFailureSignal(stderrTail);
  if (fromStderr.quotaExhausted || fromStderr.credentialInvalid) return fromStderr;
  return detectFailureSignal(cause instanceof Error ? cause.message : String(cause));
}

/** Map an ACP update onto the wire event the SPA terminal renders. */
export function toStreamEvent(update: AcpUpdate): AgentStreamEvent {
  if (update.kind === "tool_call") {
    return { kind: "tool_use", name: `${update.title} (${update.status})` };
  }
  // Thoughts are shown, marked, rather than dropped: a reviewer judging the work wants the
  // agent's reasoning, and hiding it would make the terminal disagree with the transcript.
  const prefix = update.channel === "thought" ? "· " : "";
  return { kind: "stdout", text: `${prefix}${update.text}` };
}
