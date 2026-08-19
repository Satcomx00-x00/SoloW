import {
  type ContentBlock,
  client,
  methods,
  type PermissionOption,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
  type Stream,
} from "@agentclientprotocol/sdk";

/**
 * ACP client session (task TASK-014, plan §"Agent connection").
 *
 * GateControl is the *client* in Agent Client Protocol terms: it drives an external coding
 * agent (Claude Code) that runs as a separate process. This module owns the protocol half —
 * handshake, session lifecycle, prompt turns, cancellation — and knows nothing about how the
 * process was spawned, so it can be tested against an in-process fake agent as well as a real
 * one over stdio.
 *
 * The turn model matters for the SPA terminal: ACP v1 has no "type into a running turn". A
 * prompt turn runs until the agent reports a `stopReason`, so operator input is queued and
 * delivered as the next turn (`sendInput`), and "stop" is `session/cancel` plus a close.
 */

/** What a session reports upward, already flattened out of ACP's update union. */
export type AcpUpdate =
  | { kind: "text"; channel: "agent" | "thought" | "user"; text: string }
  | { kind: "tool_call"; toolCallId: string; title: string; status: string };

export type PermissionDecision = { kind: "select"; optionId: string } | { kind: "cancel" };
export type PermissionPolicy = (request: RequestPermissionRequest) => PermissionDecision;

/**
 * Default policy: take the narrowest "allow" the agent offers, and refuse if it offers none.
 *
 * A run is headless — there is no operator watching each tool call — and the agent is confined
 * to a disposable per-Task git worktree (Principle II) whose contents reach the repository only
 * through a recorded human review (Principle I). So the review gate, not a per-tool prompt, is
 * the safety boundary. `allow_once` is preferred over `allow_always` so nothing outlives the
 * turn it was granted for. Every decision is reported to `onPermission` for the audit log.
 */
export const allowOncePolicy: PermissionPolicy = (request) => {
  const pick = (kind: PermissionOption["kind"]): PermissionOption | undefined =>
    request.options.find((o) => o.kind === kind);
  const chosen = pick("allow_once") ?? pick("allow_always");
  return chosen ? { kind: "select", optionId: chosen.optionId } : { kind: "cancel" };
};

export interface AcpSessionOptions {
  /** Working directory the agent operates in — the Task's isolated worktree. */
  cwd: string;
  onUpdate: (update: AcpUpdate) => void;
  /** Called for every permission request with the decision taken, for the audit trail. */
  onPermission?: (request: RequestPermissionRequest, decision: PermissionDecision) => void;
  permissionPolicy?: PermissionPolicy;
  clientName?: string;
}

export class AcpSession {
  private constructor(
    private readonly connection: {
      agent: {
        request: (method: string, params: unknown) => Promise<unknown>;
        notify: (method: string, params: unknown) => Promise<void>;
      };
      close: (error?: unknown) => void;
      closed: Promise<void>;
    },
    readonly sessionId: string,
  ) {}

  /**
   * Perform the handshake and open a session: `initialize` negotiates the protocol version and
   * declares what this client can do, then `session/new` binds the conversation to `cwd`.
   */
  static async connect(stream: Stream, options: AcpSessionOptions): Promise<AcpSession> {
    const policy = options.permissionPolicy ?? allowOncePolicy;

    const app = client({ name: options.clientName ?? "gatecontrol" })
      .onNotification(methods.client.session.update, (ctx) => {
        for (const update of toUpdates(ctx.params)) options.onUpdate(update);
      })
      .onRequest(methods.client.session.requestPermission, (ctx): RequestPermissionResponse => {
        const decision = policy(ctx.params);
        options.onPermission?.(ctx.params, decision);
        return decision.kind === "select"
          ? { outcome: { outcome: "selected", optionId: decision.optionId } }
          : { outcome: { outcome: "cancelled" } };
      });

    const connection = app.connect(stream);

    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      // The agent edits the worktree with its own tools; proxying the filesystem or a terminal
      // through GateControl would widen the blast radius past the worktree for no benefit.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: options.clientName ?? "gatecontrol", version: "0.1.0" },
    });

    const session = await connection.agent.request(methods.agent.session.new, {
      cwd: options.cwd,
      mcpServers: [],
    });

    return new AcpSession(
      connection as unknown as AcpSession["connection"],
      (session as { sessionId: string }).sessionId,
    );
  }

  /** Run one prompt turn and resolve with the reason the agent stopped. */
  async prompt(text: string): Promise<StopReason> {
    const prompt: ContentBlock[] = [{ type: "text", text }];
    const response = await this.connection.agent.request(methods.agent.session.prompt, {
      sessionId: this.sessionId,
      prompt,
    });
    return (response as { stopReason: StopReason }).stopReason;
  }

  /** Ask the agent to abandon the current turn. The in-flight `prompt` resolves `cancelled`. */
  async cancel(): Promise<void> {
    await this.connection.agent.notify(methods.agent.session.cancel, {
      sessionId: this.sessionId,
    });
  }

  close(): void {
    this.connection.close();
  }

  get closed(): Promise<void> {
    return this.connection.closed;
  }
}

/** Flatten one `session/update` notification into the events GateControl streams and logs. */
export function toUpdates(notification: SessionNotification): AcpUpdate[] {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return textUpdate("agent", update.content);
    case "agent_thought_chunk":
      return textUpdate("thought", update.content);
    case "user_message_chunk":
      return textUpdate("user", update.content);
    case "tool_call":
      return [
        {
          kind: "tool_call",
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status ?? "pending",
        },
      ];
    case "tool_call_update":
      return [
        {
          kind: "tool_call",
          toolCallId: update.toolCallId,
          title: update.title ?? "",
          status: update.status ?? "pending",
        },
      ];
    default:
      // Plans, mode/config changes and usage reports carry no terminal content in v1.
      return [];
  }
}

/** Only text content reaches the terminal; images and embedded resources are dropped. */
function textUpdate(channel: "agent" | "thought" | "user", content: ContentBlock): AcpUpdate[] {
  return content.type === "text" ? [{ kind: "text", channel, text: content.text }] : [];
}
