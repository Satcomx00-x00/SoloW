/// <reference types="bun-types" />
import {
  type AgentApp,
  agent,
  methods,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  type Stream,
} from "@agentclientprotocol/sdk";

/**
 * A deterministic ACP agent for tests (task TASK-014 "fake ACP agent fixture", plan §testing).
 *
 * It speaks the real protocol, so a test exercises the actual handshake, notification and
 * permission paths rather than a stub of them. `fakeAcpAgent` can be connected in-process for
 * fast protocol tests, or served over stdio (`serveFakeAgentOverStdio`) by a script the
 * orchestrator spawns, which additionally proves the process transport.
 */

export interface FakeAgentTurn {
  /** Message chunks the agent streams during this turn, in order. */
  chunks?: string[];
  /** Tool calls announced during this turn. */
  toolCalls?: string[];
  /** Ask the client for permission before doing the work, and honour a refusal. */
  requestPermission?: boolean;
  /** Files (relative to cwd) the agent writes during this turn — proves worktree isolation. */
  writes?: Array<{ path: string; content: string }>;
  /**
   * Dump the agent process's own environment variable names to this path (relative to cwd).
   * Only names: a test that printed values would put a credential in a file (Principle IV).
   */
  writeEnvNames?: string;
}

export interface FakeAgentScript {
  turns?: FakeAgentTurn[];
  /** Turn used once `turns` is exhausted, so extra prompts still get a sane response. */
  defaultTurn?: FakeAgentTurn;
}

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

export function fakeAcpAgent(script: FakeAgentScript = {}): AgentApp {
  const turns = script.turns ?? [{ chunks: ["ok"] }];
  const cwds = new Map<string, string>();
  let turnIndex = 0;

  return agent({ name: "fake-acp-agent" })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: "fake-acp-agent", version: "0.0.0" },
    }))
    .onRequest(methods.agent.session.new, (ctx) => {
      const sessionId = `fake-session-${cwds.size + 1}`;
      cwds.set(sessionId, ctx.params.cwd);
      return { sessionId };
    })
    .onRequest(methods.agent.session.prompt, async (ctx) => {
      const turn = turns[turnIndex++] ?? script.defaultTurn ?? { chunks: ["ok"] };
      const sessionId = ctx.params.sessionId;
      const notify = (update: Parameters<typeof buildUpdate>[0]) =>
        ctx.client.notify(methods.client.session.update, {
          sessionId,
          update: buildUpdate(update),
        });

      if (turn.requestPermission) {
        const response = await ctx.client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: "tool-1", title: "Edit files" },
          options: PERMISSION_OPTIONS,
        });
        const outcome = response.outcome;
        const refused = outcome.outcome === "cancelled" || !outcome.optionId.startsWith("allow");
        if (refused) {
          await notify({ kind: "text", text: "permission refused" });
          return { stopReason: "refusal" as const };
        }
        await notify({ kind: "text", text: `permission ${outcome.optionId}` });
      }

      const cwd = cwds.get(sessionId) ?? process.cwd();
      for (const name of turn.toolCalls ?? []) await notify({ kind: "tool", title: name });
      for (const write of turn.writes ?? []) {
        await Bun.write(`${cwd}/${write.path}`, write.content);
      }
      if (turn.writeEnvNames) {
        await Bun.write(
          `${cwd}/${turn.writeEnvNames}`,
          JSON.stringify(Object.keys(process.env).sort()),
        );
      }
      for (const chunk of turn.chunks ?? []) await notify({ kind: "text", text: chunk });

      return { stopReason: "end_turn" as const };
    });
}

function buildUpdate(spec: { kind: "text"; text: string } | { kind: "tool"; title: string }) {
  return spec.kind === "text"
    ? ({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: spec.text },
      } as const)
    : ({
        sessionUpdate: "tool_call",
        toolCallId: `tool-${spec.title}`,
        title: spec.title,
        status: "completed",
      } as const);
}

/** Serve a fake agent on this process's stdio — how a spawned agent fixture runs. */
export function serveFakeAgentOverStdio(script: FakeAgentScript = {}): Promise<void> {
  return fakeAcpAgent(script).connect(stdioStream()).closed;
}

/** This process's stdin/stdout as an ACP stream. */
export function stdioStream(): Stream {
  const sink = Bun.stdout.writer();
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      sink.write(chunk);
      await sink.flush();
    },
  });
  return ndJsonStream(writable, Bun.stdin.stream());
}

/**
 * Path to the runnable fake agent script. Tests that need a *spawned* agent — an orchestrator
 * runner test, an E2E fixture — point their agent command at this with `bun run`.
 */
export const FAKE_AGENT_MAIN = new URL("./fixtures/agent-main.ts", import.meta.url).pathname;
