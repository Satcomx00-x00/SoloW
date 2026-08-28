import {
  AcpMethod,
  advertisedOptions,
  type ChildProcessHandle,
  initializeParams,
  JsonRpcPeer,
  negotiate,
  sessionNewResultSchema,
} from "@solow/acp";
import { agentProtocolDescriptor } from "@solow/contracts";
import type { Executor } from "../executor/types.js";

/**
 * Does this agent actually work? (2026-08-28.)
 *
 * Until now the answer arrived mid-run: an Agent Profile could name a command that was never
 * installed, or misspelled, and the first thing that noticed was a Task failing after it had
 * been queued, worktreed and briefed. Configuring an agent and finding out whether the
 * configuration is right were separated by an entire lifecycle.
 *
 * **What it checks, and what it deliberately does not.** The command is started for real, in a
 * real Executor, because "is it installed and on PATH" is the failure that actually happens and
 * nothing short of starting it answers that. For ACP the handshake continues far enough to read
 * what the agent advertises — and no further: `initialize` and `session/new`, never a prompt.
 * `session/new` costs no inference, and a probe that quietly spent tokens to tell you a binary
 * exists would be a worse bargain than the uncertainty it replaced.
 *
 * The capability lists are the reason it goes as far as `session/new` at all: ACP advertises
 * models and modes *there* and nowhere else, so this is what fills the Profile form's model and
 * mode suggestions before a first run rather than after one.
 */

export interface AgentProbeInput {
  command: string;
  args: string[];
  /** Replaces the environment, never extends it — the same rule a real run follows (Principle IV). */
  env: Record<string, string>;
  cwd: string;
  protocol: string;
}

export interface AgentProbeResult {
  ok: boolean;
  /** Why it failed, in terms an Owner can act on. Null when it worked. */
  reason: string | null;
  /** The negotiated ACP version — min(ours, theirs). Null for a protocol without a handshake. */
  protocolVersion: number | null;
  /** Authentication the agent offers. Non-empty means it may need a credential SoloW is not giving it. */
  authMethods: string[];
  /** Advertised ids, for the Profile form's pins. Empty for a protocol that advertises nothing. */
  capabilities: { models: string[]; modes: string[] };
}

const EMPTY: Omit<AgentProbeResult, "ok" | "reason"> = {
  protocolVersion: null,
  authMethods: [],
  capabilities: { models: [], modes: [] },
};

/** How long the whole probe may take before it is called a failure. */
export const PROBE_TIMEOUT_MS = 20_000;

function reasonFor(cause: unknown, command: string): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  // The overwhelmingly common one, and the one worth naming precisely: the agent is not there.
  if (/ENOENT|not found|No such file/i.test(message)) {
    return `"${command}" could not be started — is it installed and on PATH for the orchestrator?`;
  }
  return message;
}

async function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`the agent did not answer within ${Math.round(ms / 1000)}s`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Start the agent, ask it what it is, and stop it.
 *
 * Never throws: a probe's whole job is to turn "it does not work" into something readable, so a
 * failure is a result with a reason rather than an exception the caller has to catch.
 */
export async function probeAgent(
  executor: Executor,
  input: AgentProbeInput,
): Promise<AgentProbeResult> {
  const descriptor = agentProtocolDescriptor(input.protocol);
  if (!descriptor.driven) {
    return {
      ok: false,
      reason: `this build has no runner for protocol "${input.protocol}"`,
      ...EMPTY,
    };
  }

  let proc: ChildProcessHandle | undefined;
  try {
    proc = executor.spawn([input.command, ...input.args], {
      cwd: input.cwd,
      env: input.env,
    }) as unknown as ChildProcessHandle;
  } catch (cause) {
    return { ok: false, reason: reasonFor(cause, input.command), ...EMPTY };
  }

  const kill = () => {
    try {
      proc?.kill();
    } catch {
      // Already gone. Nothing to do, and nothing worth reporting over the probe's own result.
    }
  };

  try {
    if (input.protocol !== "acp") {
      /*
       * No handshake to have. A stream-json CLI and a plain CLI both answer "am I installed" by
       * starting at all, which spawning has already proved — anything more would mean running
       * the agent for real. Killed immediately: this is a liveness check, not a run.
       */
      const started = await withTimeout(
        Promise.race([
          proc.exited.then((code) => ({ exited: true as const, code })),
          new Promise<{ exited: false }>((resolve) =>
            setTimeout(() => resolve({ exited: false }), 400),
          ),
        ]),
        PROBE_TIMEOUT_MS,
        kill,
      );
      kill();
      // A command that vanished at once with a non-zero code did not merely finish early — that
      // is how a missing interpreter or an unreadable binary reports itself.
      if (started.exited && started.code !== 0) {
        return {
          ok: false,
          reason: `"${input.command}" exited immediately with code ${started.code}`,
          ...EMPTY,
        };
      }
      return { ok: true, reason: null, ...EMPTY };
    }

    const peer = new JsonRpcPeer({
      write: (line) => {
        proc?.stdin.write(line);
        void proc?.stdin.flush();
      },
      // A probe asks and listens for its answers; an agent's notifications are not its business.
      onNotify: () => {},
    });

    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of proc.stdout) peer.feed(decoder.decode(chunk, { stream: true }));
      } catch {
        // The process ended under us; the awaited request below reports that.
      }
    })();

    const result = await withTimeout(
      (async () => {
        const negotiated = negotiate(await peer.request(AcpMethod.Initialize, initializeParams()));
        // The same parse a real session does — the shape of `session/new` is the ACP package's
        // to own, not something a probe should re-describe and drift from.
        const created = sessionNewResultSchema.parse(
          await peer.request(AcpMethod.SessionNew, { cwd: input.cwd, mcpServers: [] }),
        );
        return { negotiated, created };
      })(),
      PROBE_TIMEOUT_MS,
      kill,
    );

    return {
      ok: true,
      reason: null,
      protocolVersion: result.negotiated.protocolVersion,
      authMethods: result.negotiated.authMethods,
      capabilities: advertisedOptions(result.created),
    };
  } catch (cause) {
    return { ok: false, reason: reasonFor(cause, input.command), ...EMPTY };
  } finally {
    kill();
  }
}
