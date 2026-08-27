import { describe, expect, it } from "bun:test";
import {
  ACP_PROTOCOL_VERSION,
  assertPromptBlocks,
  CapabilityUnavailableError,
  initializeParams,
  negotiate,
  ProtocolVersionError,
  requireCapability,
  SOLOW_CLIENT_CAPABILITIES,
} from "./capabilities.js";

/**
 * AC-2 in unit form. Every case here is the same question asked a different way: does a
 * capability the agent never mentioned read as unavailable, or as "probably fine"?
 */

describe("negotiate", () => {
  it("reads every capability an agent stated nothing about as unavailable", () => {
    const caps = negotiate({ protocolVersion: 1 });
    expect(caps.loadSession).toBe(false);
    expect(caps.promptImage).toBe(false);
    expect(caps.promptAudio).toBe(false);
    expect(caps.promptEmbeddedContext).toBe(false);
  });

  it("reads an empty capability object the same way as an absent one", () => {
    // The difference between "{}" and nothing at all is not consent.
    const empty = negotiate({ protocolVersion: 1, agentCapabilities: {} });
    const absent = negotiate({ protocolVersion: 1 });
    expect(empty).toEqual(absent);
  });

  it("carries through only the capabilities the agent actually advertised", () => {
    const caps = negotiate({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
    });
    expect(caps.loadSession).toBe(true);
    expect(caps.promptImage).toBe(true);
    expect(caps.promptAudio).toBe(false);
  });

  it("negotiates down to the version both sides can speak", () => {
    const caps = negotiate({ protocolVersion: ACP_PROTOCOL_VERSION + 5 });
    expect(caps.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
  });

  it("refuses a peer below the minimum, naming both versions", () => {
    // Guessing at an older wire shape would mis-parse every message; saying so is better.
    let thrown: unknown;
    try {
      negotiate({ protocolVersion: 0 });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(ProtocolVersionError);
    expect((thrown as Error).message).toContain("0");
    expect((thrown as Error).message).toContain(String(ACP_PROTOCOL_VERSION));
  });

  it("treats a result it cannot parse as an agent that advertised nothing", () => {
    const caps = negotiate("not an object");
    expect(caps.loadSession).toBe(false);
    expect(caps.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
  });
});

describe("requireCapability", () => {
  it("throws naming the capability SoloW was about to assume", () => {
    const caps = negotiate({ protocolVersion: 1 });
    expect(() => requireCapability(caps, "loadSession")).toThrow(CapabilityUnavailableError);
    expect(() => requireCapability(caps, "loadSession")).toThrow("loadSession");
  });

  it("allows what the agent did advertise", () => {
    const caps = negotiate({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    expect(() => requireCapability(caps, "loadSession")).not.toThrow();
  });
});

describe("assertPromptBlocks", () => {
  it("refuses a content block type the agent never advertised, before it is written", () => {
    const caps = negotiate({ protocolVersion: 1 });
    expect(() => assertPromptBlocks(caps, [{ type: "image" }])).toThrow(CapabilityUnavailableError);
    expect(() => assertPromptBlocks(caps, [{ type: "resource" }])).toThrow("promptEmbeddedContext");
  });

  it("always allows plain text, which every ACP agent must accept", () => {
    const caps = negotiate({ protocolVersion: 1 });
    expect(() => assertPromptBlocks(caps, [{ type: "text" }])).not.toThrow();
  });
});

describe("what SoloW advertises as a client", () => {
  it("offers the agent no filesystem and no terminal", () => {
    // The enforcing half is in session.ts (`-32601`), but the advertisement has to agree with
    // it: telling an agent it may read files and then refusing every read is worse than saying
    // no up front.
    expect(SOLOW_CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    expect(initializeParams()).toEqual({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: SOLOW_CLIENT_CAPABILITIES,
    });
  });
});
