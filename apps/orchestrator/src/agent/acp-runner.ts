import { type AcpSession, type AcpUpdate, startAcpSession } from "@gatecontrol/acp";
import { detectFailureSignal, type FailureSignal } from "@gatecontrol/core";
import type { Executor } from "../executor/types.js";
import {
  DEFAULT_UNATTENDED_POSTURE,
  PERMISSION_DEADLINE_MS,
  PermissionInbox,
  type UnattendedPermissionPosture,
} from "./permissions.js";
import type {
  AgentHandle,
  AgentOutcome,
  AgentRunner,
  AgentStartOpts,
  AgentStreamEvent,
} from "./runner.js";

/**
 * The Agent Client Protocol as GateControl's agent transport (Decision 0003 / issue #58).
 *
 * The mirror of `ClaudeCodeRunner`, and deliberately the same shape: bind the protocol driver to
 * `Executor.spawn`, map the protocol's updates onto `AgentStreamEvent`, classify a failure from
 * what the agent said and then from its stderr. Two things differ, and both are the protocol's
 * doing rather than a design choice here:
 *
 * - **The worktree is GateControl's.** ACP has no `--worktree`; the lifecycle creates the
 *   directory and this runner is pointed at it. So `workspacePath` is known before the agent
 *   says anything, and is reported even when the run fails — the agent was isolated whether or
 *   not it got as far as working. Reporting `null` on a failed handshake would make the
 *   lifecycle blame the isolation instead of the real fault, and lose the quota park with it.
 * - **Operator input arrives a turn later.** ACP v1 cannot type into a running turn, so `send`
 *   queues the next `session/prompt`. `AgentHandle.send`'s `Promise<boolean>` already means
 *   "accepted", not "delivered to the model now", so the contract holds — but an operator used
 *   to Claude Code will see the reply arrive after the current turn finishes rather than during.
 */

export interface AcpRunnerOptions {
  /** Where the agent process actually runs — issue #1's `Executor`. */
  executor: Executor;
  /** Diagnostics sink for the agent's stderr. Never receives protocol traffic. */
  onStderr?: (text: string) => void;
  /** How long an operator has to answer a permission before the policy decides (AC-4). */
  permissionDeadlineMs?: number;
  /**
   * What an unanswered permission decays to. Refusal unless a deployment names otherwise — see
   * `permissions.ts` for why that direction is the only safe one.
   */
  unattendedPermissionPosture?: UnattendedPermissionPosture;
}

export class AcpRunner implements AgentRunner {
  constructor(private readonly options: AcpRunnerOptions) {}

  start(opts: AgentStartOpts): AgentHandle {
    const inbox = new PermissionInbox(
      this.options.permissionDeadlineMs ?? PERMISSION_DEADLINE_MS,
      this.options.unattendedPermissionPosture ?? DEFAULT_UNATTENDED_POSTURE,
    );
    let session: AcpSession | undefined;
    let stopRequested = false;

    try {
      session = startAcpSession(
        {
          command: opts.command,
          ...(opts.args.length > 0 ? { extraArgs: opts.args } : {}),
          cwd: opts.cwd,
          env: opts.env,
          spawn: (cmd, spawnOpts) => this.options.executor.spawn(cmd, spawnOpts),
          onUpdate: (update) => {
            const event = toStreamEvent(update);
            if (event) opts.onEvent(event);
          },
          onPermission: async (request) => {
            // Surfaced first, answered second — in that order, always. Publishing only the
            // requests that end up mattering would let a policy-granted permission happen with
            // nobody ever having been told about it, which is exactly what AC-4 forbids.
            opts.onEvent({
              kind: "permission_request",
              requestId: request.requestId,
              title: request.title,
              toolKind: request.kind,
              // An option with no id is dropped rather than offered. The protocol admits one —
              // its schema asks only for a string — but selecting it is impossible: the answer
              // GateControl sends back names the option by id, and an empty name resolves to a
              // cancellation whatever the operator clicked. Showing a choice that cannot be
              // made is worse than showing one fewer, and the record of the request is what the
              // session log has to keep either way (issue #58, AC-4).
              options: request.options.filter((option) => option.optionId.length > 0),
            });
            const resolution = await inbox.ask(request);
            opts.onEvent({
              kind: "permission_resolved",
              requestId: request.requestId,
              optionId: resolution.optionId,
              decidedBy: resolution.decidedBy,
            });
            // A refusal nobody chose needs saying in words as well as in the audit record: the
            // agent is about to give up on the turn, and a reviewer reading the transcript
            // afterwards should find the reason there rather than infer it from a missing
            // answer. Terminal text is appended to the session log too, so it survives.
            if (resolution.decidedBy === "policy" && resolution.outcome === "cancelled") {
              opts.onEvent({
                kind: "stdout",
                channel: "system",
                text: `\n[permission refused by policy — nobody answered "${request.title}" in time]\n`,
              });
            }
            return {
              outcome: resolution.outcome,
              ...(resolution.optionId ? { optionId: resolution.optionId } : {}),
            };
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
        workspacePath: Promise.resolve(opts.cwd),
        send: async () => false,
        stop: async () => {},
      };
    }

    const live = session;
    const outcome: Promise<AgentOutcome> = live.outcome.then((result) => {
      // Nothing is left waiting on an operator who is no longer watching a run that has ended.
      inbox.close();
      // A stop is an operator decision, not a fault: the partial work stays in the worktree and
      // goes to review like any other completed run (Principle I).
      if (stopRequested || result.ok) return { kind: "completed" };
      return { kind: "failed", signal: signalFor(result, live.stderrTail()) };
    });

    return {
      outcome,
      // Known up front, but still a promise: the shape of `AgentHandle` is set by the protocol
      // that has to discover it, and two shapes would buy nothing.
      workspacePath: Promise.resolve<string | null>(opts.cwd),
      async send(text: string) {
        return live.send(text);
      },
      async respondPermission(requestId: string, optionId: string) {
        return inbox.answer(requestId, optionId);
      },
      async stop() {
        stopRequested = true;
        // Release the turn first: an agent blocked on a permission nobody will now answer would
        // otherwise sit through the whole cancel grace before the kill.
        inbox.close();
        await live.stop();
      },
    };
  }
}

/**
 * Classify a failed run. What the agent said about the failure is the better signal when it
 * says something useful; otherwise fall back to whatever it printed on stderr, which is where
 * quota and credential problems are reported in prose.
 */
function signalFor(
  result: { stopReason: string | null; error: string | null },
  stderrTail: string,
): FailureSignal {
  const stated = detectFailureSignal(result.error ?? result.stopReason);
  if (stated.quotaExhausted || stated.credentialInvalid) return stated;
  return detectFailureSignal(stderrTail);
}

/** Map an ACP update onto the wire event the SPA terminal renders. */
export function toStreamEvent(update: AcpUpdate): AgentStreamEvent | null {
  switch (update.kind) {
    case "tool_call":
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
    case "text":
      // Thinking is carried, marked, rather than dropped: a reviewer judging the work wants the
      // agent's reasoning, and hiding it would make the terminal disagree with the transcript.
      // A `user` chunk is the agent echoing back what it was told, which is worth seeing too.
      // The channel travels with the text now instead of being baked into it as a prefix — the
      // session log needs to know whose line this was, and the "· " marker is presentation the
      // wire projection re-applies (issue #2).
      return { kind: "stdout", channel: update.channel, text: update.text };
    case "mode":
      return { kind: "stdout", channel: "system", text: `\nmode: ${update.modeId}\n` };
    // The session preamble is plumbing, and the result's text lives in the stop reason rather
    // than in prose — neither is terminal output.
    case "session":
      return null;
    case "result":
      return update.stopReason && update.stopReason !== "end_turn"
        ? { kind: "stdout", channel: "system", text: `\n[${update.stopReason}]\n` }
        : null;
  }
}
