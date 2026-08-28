import {
  assertPromptBlocks,
  initializeParams,
  type NegotiatedCapabilities,
  negotiate,
  requireCapability,
} from "./capabilities.js";
import { JsonRpcError, JsonRpcErrorCode, JsonRpcPeer } from "./jsonrpc.js";
import {
  AcpMethod,
  type AcpPermissionOption,
  type AcpUpdate,
  advertisedOptions,
  permissionRequestSchema,
  promptResultSchema,
  sessionNewResultSchema,
  textPrompt,
  toUpdates,
} from "./protocol.js";

/**
 * An ACP session over a child process's stdio (Decision 0003, issue #58).
 *
 * `initialize` → `session/new` → `session/prompt` → `session/update` → `session/cancel`, framed
 * as newline-delimited JSON-RPC 2.0. Deliberately shaped as a mirror of `startClaudeSession` so
 * the two adapters behind `AgentRunner` read the same way and diverge only where the protocols
 * genuinely do.
 *
 * They genuinely do in two places, both of which get a comment where they bite:
 *
 * - **Turn model.** ACP v1 has no way to type into a turn that is already running. Operator
 *   input is therefore *queued* and sent as the next `session/prompt`, never interleaved.
 * - **Worktree.** ACP has no `--worktree`. The caller creates the directory and passes it as
 *   `cwd`; the agent works where it is told rather than announcing where it went.
 *
 * This module never spawns anything itself — the caller supplies `spawn` (the orchestrator's
 * `Executor.spawn`), which is what keeps exactly one module in the product allowed to reach the
 * execution host.
 */

/** A long-lived child process, shaped for a line-oriented JSON-RPC protocol. */
export interface ChildProcessHandle {
  stdin: {
    write(data: string): number | Promise<number>;
    flush(): Promise<number>;
    end(): Promise<void>;
  };
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  /**
   * End the process. The signal is optional because the ordinary case is "ask it to stop": the
   * termination ladder sends none first and only names `SIGKILL` once an agent has ignored both
   * the closed stdin and the polite signal (AC-6). A handle that cannot route a signal may
   * ignore the argument — it will simply have no harsher rung to climb to.
   */
  kill(signal?: number | string): void;
}

/** Launches the agent process. Implemented by the orchestrator's `Executor.spawn`. */
export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string> },
) => ChildProcessHandle;

/** A permission the agent is asking the operator for, stripped of anything secret-bearing. */
export interface AcpPermissionRequest {
  /**
   * Correlation key for the operator's answer, unique across every run of the Task.
   *
   * Deliberately *not* the agent's own JSON-RPC id, which restarts at 1 in each spawned
   * process: the SPA pairs a request with its resolution over the Task's whole replayed event
   * history, so a second review round reusing "1" would look like a question already answered
   * and the operator would never be shown it (AC-4). The run tag in front makes it unique.
   */
  requestId: string;
  sessionId: string | null;
  toolCallId: string | null;
  /** What the agent wants to do, in its own words. Never the tool call's raw input. */
  title: string;
  kind: string | null;
  options: AcpPermissionOption[];
}

/** The answer that goes back to the agent. `cancelled` declines without choosing an option. */
export interface AcpPermissionDecision {
  outcome: "selected" | "cancelled";
  optionId?: string | null;
}

export interface AcpOutcome {
  ok: boolean;
  /** The agent's own `stopReason` for the last turn, or a synthetic one when it never said. */
  stopReason: string | null;
  /** Why the session failed outside a turn. Diagnostic prose only — never a credential. */
  error: string | null;
}

export interface AcpSessionOptions {
  /** The agent binary. */
  command: string;
  /** Extra arguments from the catalog row, appended after any SoloW requires (none yet). */
  extraArgs?: string[];
  /**
   * Where the agent works. Unlike Claude Code, an ACP agent does not create a worktree — the
   * caller has already made one and points this at it (Principle II).
   */
  cwd: string;
  /** Environment for the agent process. Replaces, never extends (Principle IV). */
  env: Record<string, string>;
  spawn: SpawnFn;
  onUpdate: (update: AcpUpdate) => void;
  onStderr?: (text: string) => void;
  /**
   * Asked when the agent requests a permission. Nothing is granted here: absent a handler the
   * request is *declined*, because a client with nobody to ask has not been given consent
   * (AC-4). The orchestrator supplies one that reaches the operator.
   */
  onPermission?: (request: AcpPermissionRequest) => Promise<AcpPermissionDecision>;
  /** Resume a previous session. Requires the agent to have advertised `loadSession` (AC-2). */
  resumeSessionId?: string;
  /** Session mode to select. Only sent when the agent listed it in `session/new` (AC-2). */
  modeId?: string;
  /** Model to select. Only sent when the agent listed it in `session/new`, same rule as the mode. */
  modelId?: string;
  /**
   * Distinguishes this run's permission ids from every other run of the same Task. Defaults to
   * a fresh random tag; a caller with a durable id of its own (a session id, a round number)
   * can pass that instead. See `AcpPermissionRequest.requestId` for why it exists.
   */
  requestIdPrefix?: string;
  /** How long `stop()` waits for the agent to honour `session/cancel` before ending it. */
  cancelGraceMs?: number;
  /** How long termination waits for a clean exit on EOF before killing. */
  exitGraceMs?: number;
  /** How long termination waits after `SIGKILL` before giving up on the child's exit. */
  killGraceMs?: number;
  /** How long `send` waits for the handshake before refusing input. */
  handshakeGraceMs?: number;
}

export interface AcpSession {
  outcome: Promise<AcpOutcome>;
  /** The agent's session id once `session/new` succeeded; null if it never did. */
  sessionId: Promise<string | null>;
  /**
   * Queue another user turn, once the handshake has put the Task brief in front of it.
   *
   * Asynchronous for that reason alone: an operator whose socket is already open can type
   * before `initialize` has answered, and input accepted in that window used to become turn 1
   * with the brief behind it — the agent's first prompt was a steering message with no task in
   * it. Resolves false when the session finished, was stopped, or never got as far as a
   * handshake to queue behind.
   */
  send(text: string): Promise<boolean>;
  stop(): Promise<void>;
  /** The last of the agent's stderr, for failure classification. Never protocol traffic. */
  stderrTail(): string;
  /** Capabilities the handshake settled on, once it has run. Null before, and on failure. */
  capabilities(): NegotiatedCapabilities | null;
}

/** How much stderr to keep for failure classification. Enough for a message, not a log file. */
const STDERR_TAIL_LIMIT = 8_192;

/** Default grace for `session/cancel`. Long enough for a turn to unwind, short enough to stop. */
export const ACP_CANCEL_GRACE_MS = 5_000;

/** Default grace between closing stdin and killing. A well-behaved agent exits on EOF. */
export const ACP_EXIT_GRACE_MS = 500;

/**
 * Default grace between `SIGTERM` and `SIGKILL`, and again between `SIGKILL` and giving up.
 *
 * Every wait in the termination ladder is bounded, because an agent that installs a `SIGTERM`
 * handler and declines to exit would otherwise leave `outcome` pending forever — and `outcome`
 * is what the durable `agent-run-N` step is awaiting (Principle III). Giving up on the exit
 * status is worse than hanging the Task only if the exit status mattered, and it does not: the
 * run is already classified by then.
 */
export const ACP_KILL_GRACE_MS = 2_000;

/** Default window in which `send` waits for the handshake rather than refusing outright. */
export const ACP_HANDSHAKE_GRACE_MS = 5_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function startAcpSession(options: AcpSessionOptions, prompt: string): AcpSession {
  const proc = options.spawn(
    [options.command, ...(options.extraArgs ?? [])],
    // Replaces the environment rather than extending it: the child sees exactly the one
    // credential the billing guard shaped, and nothing else of the orchestrator's (Principle IV).
    { cwd: options.cwd, env: options.env },
  );

  let stderrTail = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) {
      const text = decoder.decode(chunk);
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_LIMIT);
      options.onStderr?.(text);
    }
  })();

  let caps: NegotiatedCapabilities | null = null;
  let sessionId: string | null = null;
  let resolveSessionId: (id: string | null) => void = () => {};
  const sessionIdPromise = new Promise<string | null>((resolve) => {
    resolveSessionId = resolve;
  });

  let finished = false;
  let stopped = false;
  /**
   * True once the brief is on the queue, which is the earliest moment operator input can be
   * accepted without displacing it. Set in the same synchronous block as the `push`, so no
   * awaiting `send` can wake up between the two.
   */
  let ready = false;
  const queue: string[] = [];

  /**
   * Prefix making this run's permission ids unique across the Task's whole event history — see
   * `AcpPermissionRequest.requestId`. A fresh process numbers its JSON-RPC requests from 1, so
   * the id alone cannot tell round 2's question from round 1's.
   */
  const runTag = options.requestIdPrefix ?? crypto.randomUUID().slice(0, 8);

  const peer = new JsonRpcPeer({
    write: (line) => {
      proc.stdin.write(line);
      void proc.stdin.flush();
    },
    onNotify: (method, params) => {
      if (method !== AcpMethod.SessionUpdate) return;
      for (const update of toUpdates(params)) options.onUpdate(update);
    },
    onRequest: async (method, params, id) => {
      if (method === AcpMethod.SessionRequestPermission) {
        return await answerPermission(`${runTag}:${id}`, params);
      }
      // Everything else the agent might call — `fs/read_text_file`, `fs/write_text_file`,
      // `terminal/create` — is a client capability SoloW advertised as false. Refusing
      // with `-32601` is the enforcing half of AC-2: an agent must not be able to reach outside
      // its worktree through the orchestrator just because it asked nicely.
      throw new JsonRpcError(JsonRpcErrorCode.MethodNotFound, `method not found: ${method}`);
    },
  });

  async function answerPermission(requestId: string, params: unknown): Promise<unknown> {
    const parsed = permissionRequestSchema.safeParse(params);
    const call = parsed.success ? parsed.data.toolCall : undefined;
    const request: AcpPermissionRequest = {
      requestId,
      sessionId: parsed.success ? (parsed.data.sessionId ?? null) : null,
      toolCallId: call?.toolCallId ?? null,
      title: call?.title ?? "the agent is asking for permission",
      kind: call?.kind ?? null,
      options: (parsed.success ? (parsed.data.options ?? []) : []).map((o) => ({
        optionId: o.optionId,
        name: o.name ?? o.optionId,
        kind: o.kind ?? "unknown",
      })),
    };
    // No handler means nobody to ask, and nobody to ask means no consent. Declining is the
    // only honest answer; silently allowing is precisely what AC-4 forbids.
    const decision = options.onPermission
      ? await options.onPermission(request)
      : ({ outcome: "cancelled" } as const);
    return decision.outcome === "selected" && decision.optionId
      ? { outcome: { outcome: "selected", optionId: decision.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  // Pump the agent's stdout into the peer. When it ends the child is gone, so every request
  // still outstanding is rejected rather than left to hang a durable step.
  //
  // A transport-level read failure is absorbed here rather than propagated: it reaches the turn
  // loop already, as the rejection of whatever request was in flight, and letting it *also*
  // reject the termination ladder would turn a classified outcome into a rejected `outcome`
  // promise — which the durable step retries instead of reporting.
  const reading = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stdout) peer.feed(decoder.decode(chunk, { stream: true }));
      peer.close(new Error("the agent closed its output stream"));
    } catch (cause) {
      peer.close(cause instanceof Error ? cause : new Error(String(cause)));
    }
  })();

  let terminating: Promise<void> | null = null;
  /**
   * Close-then-kill ladder: EOF first so a well-behaved agent exits on its own, then a polite
   * signal, then `SIGKILL` (AC-6).
   *
   * Every rung is time-boxed. An agent that installs a `SIGTERM` handler and keeps running is
   * not hypothetical — it is what a shell wrapper around a long-lived tool does by accident —
   * and an unbounded `await proc.exited` would hang the durable step that is waiting on
   * `outcome` rather than failing it legibly (Principle III).
   */
  const terminate = async (): Promise<void> => {
    if (terminating) return terminating;
    const killGrace = options.killGraceMs ?? ACP_KILL_GRACE_MS;
    terminating = (async () => {
      try {
        await proc.stdin.end();
      } catch {
        // Already closed.
      }
      await Promise.race([proc.exited, delay(options.exitGraceMs ?? ACP_EXIT_GRACE_MS)]);
      proc.kill();
      await Promise.race([proc.exited, delay(killGrace)]);
      // Still there. `SIGKILL` cannot be caught, so this rung either works or the host is gone.
      proc.kill("SIGKILL");
      await Promise.race([proc.exited, delay(killGrace)]);
      // The stdout pump ends when the child's output stream does; bounded for the same reason.
      await Promise.race([reading, delay(killGrace)]);
    })();
    return terminating;
  };

  /** Resolves when the turn loop has stopped driving the session, however it ended. */
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const outcome: Promise<AcpOutcome> = (async () => {
    let last: AcpOutcome | null = null;
    try {
      const initResult = await peer.request(AcpMethod.Initialize, initializeParams());
      const negotiated = negotiate(initResult);
      caps = negotiated;

      if (options.resumeSessionId) {
        // Guarded, not attempted: an agent that never advertised `loadSession` would answer
        // this with an error mid-run, after the process is already up and billing.
        requireCapability(negotiated, "loadSession");
        await peer.request(AcpMethod.SessionLoad, {
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers: [],
        });
        sessionId = options.resumeSessionId;
      } else {
        const created = sessionNewResultSchema.parse(
          await peer.request(AcpMethod.SessionNew, { cwd: options.cwd, mcpServers: [] }),
        );
        sessionId = created.sessionId;
        /*
         * Report what the agent advertised, before anything is chosen from it (issue #94 AC-2).
         *
         * This is the only moment the lists exist: an ACP agent says what it offers in the
         * `session/new` result and nowhere else, so a consumer that wants to cache them for a
         * picker has exactly this update to read. Which key it says it in is the agent's business
         * — `advertisedOptions` reads both shapes.
         */
        const advertised = advertisedOptions(created);
        if (advertised.models.length > 0 || advertised.modes.length > 0) {
          options.onUpdate({ kind: "capabilities", ...advertised });
        }
        /*
         * A pin is only ever sent for an id the agent itself offered — SoloW never invents one
         * and hopes (AC-2). That guard is also what makes `session/set_model` safe to send at
         * all: an agent that advertises no models is an agent this never speaks it to.
         */
        if (options.modeId && advertised.modes.includes(options.modeId)) {
          await peer.request(AcpMethod.SessionSetMode, { sessionId, modeId: options.modeId });
        }
        if (options.modelId && advertised.models.includes(options.modelId)) {
          await peer.request(AcpMethod.SessionSetModel, { sessionId, modelId: options.modelId });
        }
      }

      resolveSessionId(sessionId);
      options.onUpdate({ kind: "session", sessionId, cwd: options.cwd });

      // The brief goes on the queue before anything else can: `ready` is what `send` waits for,
      // and setting it here — after the push, in the same synchronous block — is what stops
      // operator input typed during the handshake from becoming turn 1.
      queue.push(prompt);
      ready = true;
      let turn = 0;
      for (;;) {
        const text = queue.shift();
        if (text === undefined || stopped) break;
        const blocks = textPrompt(text);
        assertPromptBlocks(negotiated, blocks);
        turn += 1;
        const result = promptResultSchema.parse(
          await peer.request(AcpMethod.SessionPrompt, { sessionId, prompt: blocks }),
        );
        const stopReason = result.stopReason ?? null;
        // ACP states no usage of its own, so the turn is reported with nothing known rather
        // than omitted — see the `usage` member of `AcpUpdate` for why that matters.
        options.onUpdate({
          kind: "usage",
          messageId: `${sessionId ?? "acp"}:${turn}`,
          reported: false,
          model: null,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        last = { ok: isSuccessfulStop(stopReason), stopReason, error: null };
        options.onUpdate({ kind: "result", ...last });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A stop tears the transport down on purpose; the resulting rejection is the operator's
      // decision arriving, not a fault (Principle I).
      last = stopped
        ? { ok: true, stopReason: "cancelled", error: null }
        : // No stop reason ever arrived for the turn that was in flight: the agent died, or
          // refused the handshake. An exit code alone does not say it succeeded.
          { ok: false, stopReason: "no_result", error: message };
    } finally {
      finished = true;
      resolveSessionId(sessionId);
      settle();
    }

    // Guarded, not awaited bare: a failure while shutting the child down must not reject
    // `outcome`. `AcpRunner` closes its permission inbox when this promise *resolves*, and the
    // durable `agent-run-N` step classifies an `AcpOutcome` rather than retrying a throw.
    await terminate().catch((cause) => {
      last ??= {
        ok: false,
        stopReason: "no_result",
        error: cause instanceof Error ? cause.message : String(cause),
      };
    });
    if (stopped) return { ok: true, stopReason: "cancelled", error: null };
    // No turn result at all means the agent died before finishing one. An exit code alone does
    // not say it succeeded, so absence is treated as failure.
    return last ?? { ok: false, stopReason: "no_result", error: null };
  })();

  return {
    outcome,
    sessionId: sessionIdPromise,
    stderrTail: () => stderrTail,
    capabilities: () => caps,
    async send(text: string) {
      // Gated on the handshake, and bounded so an agent stuck in `initialize` cannot leave the
      // operator's socket waiting for an acknowledgement: the brief must already be on the
      // queue before anything the operator typed can join it behind.
      if (!ready) {
        await Promise.race([
          sessionIdPromise,
          delay(options.handshakeGraceMs ?? ACP_HANDSHAKE_GRACE_MS),
        ]);
      }
      if (!ready || finished || stopped) return false;
      // Queued, not interleaved: ACP v1 has no way to type into a running turn, so the
      // operator's message becomes the *next* `session/prompt`. The `AgentHandle.send`
      // contract already means "accepted", not "delivered to the model now".
      queue.push(text);
      return true;
    },
    async stop() {
      // Termination failures are swallowed on both rungs below, the same way the outcome path
      // guards its own `terminate()`: an executor whose `kill()` throws must not turn "stop this
      // agent" into a rejection the operator's socket has to handle. The outcome is what
      // classifies the run; stop only has to end it.
      if (stopped) {
        await terminate().catch(() => undefined);
        return;
      }
      stopped = true;
      const grace = options.cancelGraceMs ?? ACP_CANCEL_GRACE_MS;
      // An operator can press stop before the handshake has finished. Waiting briefly for the
      // session id means the agent is *asked* to cancel rather than merely killed out from
      // under itself — which is the difference between AC-6's "cleanly" and a SIGKILL.
      const id = sessionId ?? (await Promise.race([sessionIdPromise, delay(grace)]));
      // Cancellation is a notification in ACP — there is no response to wait for. The agent is
      // expected to answer the in-flight `session/prompt` with `stopReason: "cancelled"`.
      if (id) peer.notify(AcpMethod.SessionCancel, { sessionId: id });
      await Promise.race([settled, delay(grace)]);
      await terminate().catch(() => undefined);
      // The turn loop unwinds through the rejected request; wait for it so `stop()` resolving
      // really does mean the session is over.
      await outcome.catch(() => undefined);
    },
  };
}

/**
 * Whether a stop reason describes a turn that ended acceptably.
 *
 * `refusal` is the one that is not: the agent declined to do the work, and reporting that as a
 * completed run would send an empty worktree to review as though it were an attempt. Anything
 * unrecognised is treated as success, because a later protocol revision naming a new ordinary
 * ending must not fail runs on this build.
 */
function isSuccessfulStop(stopReason: string | null): boolean {
  return stopReason !== null && stopReason !== "refusal";
}
