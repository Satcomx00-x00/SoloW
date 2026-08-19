/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { type AnyMessage, methods, type Stream } from "@agentclientprotocol/sdk";
import { AcpSession, type AcpUpdate, allowOncePolicy } from "./session.js";
import { fakeAcpAgent } from "./testing.js";

/**
 * ACP protocol half (task TASK-014). These connect a real client to a real (fake-scripted)
 * agent in-process, so the handshake, `session/update` fan-out, permission request/response and
 * cancellation all run through the actual protocol implementation.
 */

/** Connect an `AcpSession` to a scripted agent, collecting everything it streams. */
async function connect(
  script: Parameters<typeof fakeAcpAgent>[0] = {},
  options: Partial<Parameters<typeof AcpSession.connect>[1]> = {},
) {
  const updates: AcpUpdate[] = [];
  const permissions: string[] = [];
  const session = await AcpSession.connect(bridgeToAgent(fakeAcpAgent(script)), {
    cwd: "/tmp/worktree",
    onUpdate: (u) => updates.push(u),
    onPermission: (_req, decision) =>
      permissions.push(decision.kind === "select" ? decision.optionId : "cancel"),
    ...options,
  });
  return { session, updates, permissions };
}

/**
 * Wire the agent to an in-memory transport and hand back the client's end. Real JSON-RPC
 * messages cross it — only the process boundary is missing, and `spawn.test.ts` covers that.
 */
function bridgeToAgent(agentApp: ReturnType<typeof fakeAcpAgent>): Stream {
  const toAgent = new TransformStream<AnyMessage, AnyMessage>();
  const toClient = new TransformStream<AnyMessage, AnyMessage>();
  agentApp.connect({ readable: toAgent.readable, writable: toClient.writable });
  return { readable: toClient.readable, writable: toAgent.writable };
}

describe("AcpSession", () => {
  it("completes the handshake and opens a session bound to the worktree", async () => {
    const { session } = await connect();
    expect(session.sessionId).toBe("fake-session-1");
    session.close();
  });

  it("streams agent message chunks and tool calls to the caller, in order", async () => {
    const { session, updates } = await connect({
      turns: [{ toolCalls: ["read"], chunks: ["patched ", "latch.ts\n"] }],
    });

    const stopReason = await session.prompt("fix the latch");
    expect(stopReason).toBe("end_turn");
    expect(updates).toEqual([
      { kind: "tool_call", toolCallId: "tool-read", title: "read", status: "completed" },
      { kind: "text", channel: "agent", text: "patched " },
      { kind: "text", channel: "agent", text: "latch.ts\n" },
    ]);
    session.close();
  });

  it("answers a permission request with the narrowest allow and reports the decision", async () => {
    const { session, updates, permissions } = await connect({
      turns: [{ requestPermission: true }],
    });

    await session.prompt("edit files");
    expect(permissions).toEqual(["allow-once"]);
    expect(updates).toContainEqual({
      kind: "text",
      channel: "agent",
      text: "permission allow-once",
    });
    session.close();
  });

  it("refuses when the policy declines, and the agent stops rather than acting", async () => {
    const { session, permissions } = await connect(
      { turns: [{ requestPermission: true }] },
      { permissionPolicy: () => ({ kind: "cancel" }) },
    );

    expect(await session.prompt("edit files")).toBe("refusal");
    expect(permissions).toEqual(["cancel"]);
    session.close();
  });

  it("delivers a follow-up prompt as its own turn, so operator input reaches the agent", async () => {
    const { session, updates } = await connect({
      turns: [{ chunks: ["first"] }, { chunks: ["second"] }],
    });

    await session.prompt("do the thing");
    await session.prompt("now also add a test");
    expect(updates.map((u) => (u.kind === "text" ? u.text : u.title))).toEqual(["first", "second"]);
    session.close();
  });
});

describe("allowOncePolicy", () => {
  const request = (kinds: Array<"allow_once" | "allow_always" | "reject_once">) => ({
    sessionId: "s",
    toolCall: { toolCallId: "t" },
    options: kinds.map((kind, i) => ({ optionId: `${kind}-${i}`, name: kind, kind })),
  });

  it("prefers a single-use grant over a standing one", () => {
    expect(allowOncePolicy(request(["allow_always", "allow_once"]))).toEqual({
      kind: "select",
      optionId: "allow_once-1",
    });
  });

  it("falls back to a standing grant when that is all the agent offers", () => {
    expect(allowOncePolicy(request(["allow_always"]))).toEqual({
      kind: "select",
      optionId: "allow_always-0",
    });
  });

  it("cancels when no option would allow the action", () => {
    expect(allowOncePolicy(request(["reject_once"]))).toEqual({ kind: "cancel" });
  });
});

describe("protocol method names", () => {
  it("uses the SDK's constants rather than inline strings", () => {
    expect(methods.agent.session.prompt).toBe("session/prompt");
    expect(methods.client.session.update).toBe("session/update");
  });
});
