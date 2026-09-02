/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { hubUrlFor } from "./stream";

/**
 * Which host the browser is told to dial for the live channel.
 *
 * The bug this pins: every local install configures `ws://localhost:5001`, and the server handed
 * that string to every browser — including one on another machine, which then dialled its own
 * localhost and got nothing. Nothing reported it. The socket simply retried for ever while the
 * board, the project table and the terminal quietly stopped being live.
 */

describe("hubUrlFor", () => {
  it("fills a loopback placeholder in with the host the client actually reached", () => {
    const url = hubUrlFor("ws://localhost:5001", "192.168.1.137:5000");
    expect(url.hostname).toBe("192.168.1.137");
    // The port and scheme are real configuration; only the placeholder hostname is filled in.
    expect(url.port).toBe("5001");
    expect(url.protocol).toBe("ws:");
  });

  it("leaves a configured host alone — that is a deployment saying where its hub lives", () => {
    const url = hubUrlFor("wss://hub.example.com:443", "app.example.com");
    expect(url.hostname).toBe("hub.example.com");
  });

  it("changes nothing for a browser that really is on the same machine", () => {
    expect(hubUrlFor("ws://localhost:5001", "localhost:5000").hostname).toBe("localhost");
    expect(hubUrlFor("ws://localhost:5001", "127.0.0.1:5000").hostname).toBe("localhost");
  });

  it("keeps the configured host when there is no Host header to learn from", () => {
    expect(hubUrlFor("ws://localhost:5001", null).hostname).toBe("localhost");
  });

  it("keeps the configured host when the header is not something it can parse", () => {
    // Never trust a header into a URL: an unparseable one falls back rather than throwing on a
    // request whose only fault is a malformed header.
    expect(hubUrlFor("ws://localhost:5001", "not a host!!").hostname).toBe("localhost");
  });

  it("treats every spelling of loopback as a placeholder", () => {
    for (const configured of ["ws://127.0.0.1:5001", "ws://0.0.0.0:5001", "ws://[::1]:5001"]) {
      expect(hubUrlFor(configured, "10.0.0.4:5000").hostname).toBe("10.0.0.4");
    }
  });
});
