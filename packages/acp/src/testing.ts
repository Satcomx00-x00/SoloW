/// <reference types="bun-types" />

import { JsonRpcError, JsonRpcErrorCode, JsonRpcPeer } from "./jsonrpc.js";
import { AcpMethod } from "./protocol.js";
import type { ChildProcessHandle } from "./session.js";

/**
 * A scripted stand-in for an ACP agent (Principle VI — the DoD's "no live agent in CI").
 *
 * It speaks the real protocol: real JSON-RPC framing, a real `initialize` handshake, real
 * `session/update` notifications, and real client-bound requests for permissions. A test
 * therefore exercises SoloW's actual negotiation, framing, permission and kill paths
 * rather than stubs of them — which is the only way a conformance test is worth writing.
 *
 * Two levels, the same pair `packages/claude-code/src/testing.ts` already establishes:
 * `scriptedAcpPeer` runs in-process for fast protocol tests, and `writeFakeAcpBin` produces a
 * real binary for the tests that must prove what a *spawned* child sees (its environment, its
 * working directory, what happens when it is killed).
 */

export interface AcpScriptTurn {
  /** Emitted as `agent_thought_chunk` updates. */
  thought?: string[];
  /** Emitted as `agent_message_chunk` updates. */
  text?: string[];
  /** Tool call titles, emitted as `tool_call` updates. */
  toolCalls?: string[];
  /** Files (relative to the session cwd) written during this turn. */
  writes?: Array<{ path: string; content: string }>;
  /** Ask the client for a permission and wait for its answer before finishing the turn. */
  permission?: {
    title: string;
    kind?: string;
    /** Deliberately raw: a real agent's tool call carries this, and SoloW must drop it. */
    rawInput?: unknown;
    options: Array<{ optionId: string; name: string; kind: string }>;
  };
  /**
   * Call a client method SoloW advertises as unavailable (`fs/read_text_file`, …). The
   * refusal is echoed back as agent text so a test can see the run carried on regardless.
   */
  callsClientMethod?: string;
  /**
   * Never finish this turn on its own. The only ways out are `session/cancel` and being killed
   * — which is what makes AC-6's ladder testable without racing a turn that ends instantly.
   */
  hang?: boolean;
  /** The turn's `stopReason`. Defaults to `end_turn`. */
  stopReason?: string;
}

export interface AcpScript {
  /** What the agent claims in `initialize`. Defaults to 1. */
  protocolVersion?: number;
  /** Verbatim `agentCapabilities`. Absent means an agent that advertised nothing. */
  agentCapabilities?: Record<string, unknown>;
  /** Modes offered by `session/new`. */
  modes?: { currentModeId?: string; availableModes: Array<{ id: string; name: string }> };
  /** What `session/new` advertises as selectable models, when the script wants to say any. */
  models?: { currentModelId?: string; availableModels: Array<{ modelId: string }> };
  turns?: AcpScriptTurn[];
  /** Refuse `initialize` with this message. */
  failInitialize?: string;
  /**
   * Ignore `session/cancel` *and* stdin EOF, so only the kill ends the process. This is the
   * badly-behaved agent AC-6's backstop exists for.
   */
  ignoreCancel?: boolean;
  /** Write every frame in two halves, to prove reassembly across a read boundary. */
  splitFrames?: boolean;
  /** Exit at startup without ever answering `initialize`. */
  dieEarly?: boolean;
  /** Written to stderr before anything else, for failure-classification tests. */
  stderr?: string;
  /**
   * Write the *names* of the child's environment variables to this path under the session cwd.
   * Names only, never values — the point is to prove which variables reached the agent
   * (Principle IV / AC-5), and writing a credential to a file to prove it is absent would be a
   * self-defeating test.
   */
  writeEnvNames?: string;
}

/** Where a scripted agent's bytes go. Implemented over a pipe, or over `process.stdout`. */
interface AgentIo {
  write(line: string): void;
  writeErr(text: string): void;
  /** The agent has finished; the process should end. */
  exit(): void;
}

const noop = (): void => {};

/**
 * One scripted agent, driven by whatever transport it is given. This is the whole protocol
 * implementation; `scriptedAcpPeer` and `serveScriptedAcpAgent` differ only in their plumbing.
 */
class ScriptedAgent {
  /** Every client→agent method, in order — the method-ordering conformance assertion. */
  readonly methods: string[] = [];
  readonly peer: JsonRpcPeer;
  private cwd = process.cwd();
  private turnIndex = 0;
  private cancelTurn: (() => void) | null = null;

  constructor(
    private readonly script: AcpScript,
    private readonly io: AgentIo,
  ) {
    this.peer = new JsonRpcPeer({
      write: (line) => {
        if (!this.script.splitFrames) {
          this.io.write(line);
          return;
        }
        const half = Math.max(1, Math.floor(line.length / 2));
        this.io.write(line.slice(0, half));
        this.io.write(line.slice(half));
      },
      onRequest: (method, params) => this.handle(method, params),
      onNotify: (method) => {
        this.methods.push(method);
        if (method === AcpMethod.SessionCancel && !this.script.ignoreCancel) this.cancelTurn?.();
      },
    });
  }

  feed(text: string): void {
    this.peer.feed(text);
  }

  /** stdin closed. A well-behaved agent exits; the badly-behaved one in the script does not. */
  endOfInput(): void {
    if (!this.script.ignoreCancel) this.io.exit();
  }

  private async handle(method: string, params: unknown): Promise<unknown> {
    this.methods.push(method);
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method) {
      case AcpMethod.Initialize: {
        if (this.script.failInitialize) {
          throw new JsonRpcError(JsonRpcErrorCode.InternalError, this.script.failInitialize);
        }
        return {
          protocolVersion: this.script.protocolVersion ?? 1,
          agentCapabilities: this.script.agentCapabilities ?? {},
          authMethods: [],
        };
      }
      case AcpMethod.SessionNew: {
        this.cwd = typeof p["cwd"] === "string" ? p["cwd"] : this.cwd;
        if (this.script.writeEnvNames) {
          await Bun.write(
            `${this.cwd}/${this.script.writeEnvNames}`,
            JSON.stringify(Object.keys(process.env).sort()),
          );
        }
        return {
          sessionId: "acp-session-1",
          ...(this.script.modes ? { modes: this.script.modes } : {}),
          ...(this.script.models ? { models: this.script.models } : {}),
        };
      }
      case AcpMethod.SessionLoad:
      case AcpMethod.SessionSetMode:
        return {};
      case AcpMethod.SessionPrompt:
        return await this.runTurn();
      default:
        throw new JsonRpcError(JsonRpcErrorCode.MethodNotFound, `method not found: ${method}`);
    }
  }

  private notifyUpdate(update: Record<string, unknown>): void {
    this.peer.notify(AcpMethod.SessionUpdate, { sessionId: "acp-session-1", update });
  }

  private async runTurn(): Promise<{ stopReason: string }> {
    const turn = this.script.turns?.[this.turnIndex++] ?? { text: ["ok"] };
    const cancelled = new Promise<{ stopReason: string }>((resolve) => {
      this.cancelTurn = () => resolve({ stopReason: "cancelled" });
    });
    const work = this.performTurn(turn);
    const result = await Promise.race([work, cancelled]);
    this.cancelTurn = null;
    // A cancelled turn ends the agent, the way a real one exits after the client stops it.
    if (result.stopReason === "cancelled") queueMicrotask(() => this.io.exit());
    return result;
  }

  private async performTurn(turn: AcpScriptTurn): Promise<{ stopReason: string }> {
    for (const thought of turn.thought ?? []) {
      this.notifyUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: thought },
      });
    }
    for (const title of turn.toolCalls ?? []) {
      this.notifyUpdate({
        sessionUpdate: "tool_call",
        toolCallId: `call-${title}`,
        title,
        kind: "edit",
        status: "in_progress",
      });
    }
    for (const write of turn.writes ?? []) {
      await Bun.write(`${this.cwd}/${write.path}`, write.content);
    }

    if (turn.callsClientMethod) {
      try {
        await this.peer.request(turn.callsClientMethod, { path: `${this.cwd}/anything` });
        this.notifyUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "client answered" },
        });
      } catch (cause) {
        const code = cause instanceof JsonRpcError ? cause.code : 0;
        this.notifyUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `client refused with ${code}` },
        });
      }
    }

    if (turn.permission) {
      const answer = (await this.peer.request(AcpMethod.SessionRequestPermission, {
        sessionId: "acp-session-1",
        toolCall: {
          toolCallId: "call-perm",
          title: turn.permission.title,
          kind: turn.permission.kind ?? "edit",
          rawInput: turn.permission.rawInput ?? { secret: "never-leaves-the-agent" },
        },
        options: turn.permission.options,
      })) as { outcome?: { outcome?: string; optionId?: string } };
      const outcome = answer?.outcome?.outcome ?? "cancelled";
      this.notifyUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `permission ${outcome}:${answer?.outcome?.optionId ?? ""}` },
      });
      // A declined permission is the agent giving up on the turn, which ACP calls a refusal.
      if (outcome !== "selected") return { stopReason: "refusal" };
    }

    for (const text of turn.text ?? []) {
      this.notifyUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      });
    }
    if (turn.hang) await new Promise<never>(() => {});
    return { stopReason: turn.stopReason ?? "end_turn" };
  }
}

/** A byte stream a test can push into, shaped like a child process's stdout. */
class ByteStream implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private readonly waiting: Array<(r: IteratorResult<Uint8Array>) => void> = [];
  private done = false;

  push(text: string): void {
    if (this.done) return;
    const bytes = new TextEncoder().encode(text);
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: bytes, done: false });
    else this.chunks.push(bytes);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiting.splice(0)) {
      waiter({ value: undefined as unknown as Uint8Array, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const chunk = this.chunks.shift();
        if (chunk) return Promise.resolve({ value: chunk, done: false });
        if (this.done) {
          return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

/** An in-process ACP peer shaped as a `ChildProcessHandle`, for protocol tests without a fork. */
export function scriptedAcpPeer(script: AcpScript = {}): ChildProcessHandle & {
  /** Client→agent methods, in the order the agent saw them. */
  methods: string[];
  killed: boolean;
} {
  const stdout = new ByteStream();
  const stderr = new ByteStream();
  let resolveExit: (code: number) => void = noop;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let ended = false;
  const handle = {
    methods: [] as string[],
    killed: false,
    stdin: {
      write: (data: string) => {
        agent.feed(data);
        return data.length;
      },
      flush: async () => 0,
      end: async () => {
        agent.endOfInput();
      },
    },
    stdout,
    stderr,
    exited,
    kill: () => {
      handle.killed = true;
      finish();
    },
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    stdout.end();
    stderr.end();
    resolveExit(0);
  };

  const agent = new ScriptedAgent(script, {
    write: (line) => stdout.push(line),
    writeErr: (text) => stderr.push(text),
    exit: finish,
  });
  handle.methods = agent.methods;

  if (script.stderr) stderr.push(script.stderr);
  if (script.dieEarly) queueMicrotask(finish);

  return handle;
}

/** Run the scripted agent on this process's stdio — what the spawned fake actually does. */
export async function serveScriptedAcpAgent(script: AcpScript): Promise<void> {
  if (script.stderr) process.stderr.write(script.stderr);
  if (script.dieEarly) return;

  let running = true;
  const agent = new ScriptedAgent(script, {
    write: (line) => {
      process.stdout.write(line);
    },
    writeErr: (text) => {
      process.stderr.write(text);
    },
    exit: () => {
      running = false;
      // Let whatever the agent just wrote drain before the process goes away.
      setTimeout(() => process.exit(0), 10);
    },
  });

  for await (const line of console) {
    if (!running) break;
    agent.feed(`${line}\n`);
  }
}

/** Path to the runnable fake, for tests that need to *spawn* an ACP agent. */
export const FAKE_ACP_MAIN = new URL("./fixtures/acp-main.ts", import.meta.url).pathname;

/**
 * Write an executable ACP agent at `dir/acp-agent`, following `script`.
 *
 * A shell shim rather than `bun run fixture.ts` directly, for the same reason the Claude fake
 * needs one: the runner puts the catalog row's own arguments after the command, and bun would
 * try to interpret them as its own.
 */
export async function writeFakeAcpBin(dir: string, script: AcpScript): Promise<string> {
  const binPath = `${dir}/acp-agent`;
  await Bun.write(
    binPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} run ${JSON.stringify(FAKE_ACP_MAIN)} ${JSON.stringify(
      JSON.stringify(script),
    )} "$@"\n`,
  );
  await Bun.$`chmod +x ${binPath}`.quiet();
  return binPath;
}
