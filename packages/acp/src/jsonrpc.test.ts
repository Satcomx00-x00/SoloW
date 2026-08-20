import { describe, expect, it } from "bun:test";
import { JsonRpcError, JsonRpcErrorCode, JsonRpcPeer, parseJsonRpcMessage } from "./jsonrpc.js";

/**
 * JSON-RPC framing conformance. These are the failures a session-level test would hide behind a
 * passing handshake: a frame split across a read boundary, a response nobody is waiting on, a
 * child that dies with requests outstanding.
 */

/** A peer wired to a list of the lines it wrote, so a test can read the wire directly. */
function peerWithSink(options: Partial<ConstructorParameters<typeof JsonRpcPeer>[0]> = {}) {
  const written: string[] = [];
  const peer = new JsonRpcPeer({ write: (line) => written.push(line), ...options });
  return { peer, written, sent: () => written.map((l) => JSON.parse(l)) };
}

describe("parseJsonRpcMessage", () => {
  it("ignores a line that is not JSON at all, so a banner does not end a run", () => {
    expect(parseJsonRpcMessage("Starting agent v3…")).toBeNull();
    expect(parseJsonRpcMessage("")).toBeNull();
  });

  it("ignores valid JSON that is not a JSON-RPC message", () => {
    expect(parseJsonRpcMessage('{"hello":"world"}')).toBeNull();
    expect(parseJsonRpcMessage("[1,2,3]")).toBeNull();
  });

  it("tells a request from a notification by the presence of an id", () => {
    const request = parseJsonRpcMessage('{"jsonrpc":"2.0","id":7,"method":"initialize"}');
    expect(request).toEqual({ jsonrpc: "2.0", id: 7, method: "initialize", params: undefined });
    const notification = parseJsonRpcMessage('{"jsonrpc":"2.0","method":"session/update"}');
    expect(notification && "id" in notification).toBe(false);
  });
});

describe("JsonRpcPeer framing", () => {
  it("reassembles a message split across two feeds and delivers it exactly once", async () => {
    const seen: string[] = [];
    const { peer } = peerWithSink({ onNotify: (method) => seen.push(method) });
    const line = `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} })}\n`;
    const half = Math.floor(line.length / 2);

    peer.feed(line.slice(0, half));
    expect(seen).toEqual([]);
    peer.feed(line.slice(half));

    expect(seen).toEqual(["session/update"]);
  });

  it("answers a request for a method it has no handler for, rather than hanging the peer", async () => {
    const { peer, sent } = peerWithSink();
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "fs/read_text_file" })}\n`);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent()[0]).toMatchObject({
      id: 1,
      error: { code: JsonRpcErrorCode.MethodNotFound },
    });
  });

  it("lets a handler refuse with the code it chooses", async () => {
    const { peer, sent } = peerWithSink({
      onRequest: async () => {
        throw new JsonRpcError(JsonRpcErrorCode.InvalidParams, "no");
      },
    });
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "anything" })}\n`);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent()[0]).toMatchObject({ id: 2, error: { code: JsonRpcErrorCode.InvalidParams } });
  });

  it("drops a response for an id nobody is waiting on", () => {
    const { peer } = peerWithSink();
    // Resolving something twice would be worse than losing a duplicate.
    expect(() =>
      peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} })}\n`),
    ).not.toThrow();
    expect(peer.pending).toBe(0);
  });

  it("resolves a request when its response arrives, and rejects on an error response", async () => {
    const { peer } = peerWithSink();
    const ok = peer.request("initialize");
    const bad = peer.request("session/new");
    expect(peer.pending).toBe(2);

    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } })}\n`);
    peer.feed(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "boom" } })}\n`,
    );

    expect(await ok).toEqual({ protocolVersion: 1 });
    await expect(bad).rejects.toThrow("boom");
    expect(peer.pending).toBe(0);
  });

  it("close() rejects every outstanding request, so a dead child cannot hang a step", async () => {
    const { peer } = peerWithSink();
    const first = peer.request("session/prompt");
    const second = peer.request("session/prompt");

    peer.close(new Error("the agent closed its output stream"));

    await expect(first).rejects.toThrow("closed its output stream");
    await expect(second).rejects.toThrow("closed its output stream");
    expect(peer.pending).toBe(0);
    // And a request made afterwards fails immediately rather than waiting for a peer that is gone.
    await expect(peer.request("initialize")).rejects.toThrow("closed its output stream");
  });
});
