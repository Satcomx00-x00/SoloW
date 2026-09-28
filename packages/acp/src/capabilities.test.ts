import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ACP_PROTOCOL_VERSION,
  assertPromptBlocks,
  CapabilityUnavailableError,
  HarnessVersionError,
  initializeParams,
  meetsMinimumVersion,
  negotiate,
  ProtocolVersionError,
  requireCapability,
  requireMinimumVersion,
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

describe("agentInfo", () => {
  // Captured from `opencode acp` 1.18.33 on 2026-09-28 — the build the catalog pins.
  const opencode = JSON.parse(
    readFileSync(new URL("./fixtures/opencode-1.18.33-initialize.json", import.meta.url), "utf8"),
  );

  it("reads which build answered from a real opencode handshake", () => {
    const caps = negotiate(opencode);
    expect(caps.agent).toEqual({ name: "OpenCode", version: "1.18.33" });
    // The rest of the handshake still reads as it did: the new field takes nothing away.
    expect(caps.loadSession).toBe(true);
    expect(caps.authMethods).toEqual(["opencode-login"]);
  });

  it("is null when the agent does not say who it is", () => {
    expect(negotiate({ protocolVersion: 1 }).agent).toBeNull();
  });

  it("keeps the name and reads the version as unknown when only the name was sent", () => {
    expect(negotiate({ protocolVersion: 1, agentInfo: { name: "x" } }).agent).toEqual({
      name: "x",
      version: null,
    });
  });

  it("ignores a malformed agentInfo rather than failing the handshake over it", () => {
    const caps = negotiate({
      protocolVersion: 1,
      agentInfo: "opencode",
      agentCapabilities: { loadSession: true },
    });
    expect(caps.agent).toBeNull();
    expect(caps.loadSession).toBe(true);
  });
});

describe("meetsMinimumVersion", () => {
  const table: Array<[actual: string, minimum: string, meets: boolean, why: string]> = [
    ["1.18.33", "1.18.33", true, "the pinned build itself"],
    ["1.18.34", "1.18.33", true, "a newer patch"],
    ["1.19.0", "1.18.33", true, "a newer minor, with a smaller patch"],
    ["2.0.0", "1.18.33", true, "a newer major"],
    ["1.18.32", "1.18.33", false, "an older patch"],
    ["1.9.99", "1.18.33", false, "numeric, not lexical: 9 < 18"],
    ["v1.18.33", "1.18.33", true, "a leading v, as release tags spell it"],
    ["1.18.33", "v1.18.33", true, "a leading v on the pin"],
    ["1.18.33-beta.2", "1.18.33", false, "a pre-release of the minimum comes before it"],
    ["1.18.34-beta.1", "1.18.33", true, "a pre-release of a later build is still later"],
    ["1.18.33+build.7", "1.18.33", true, "build metadata changes nothing"],
    ["1.18", "1.18.0", true, "a missing part counts as zero"],
    ["latest", "1.18.33", false, "garbage never meets a pin"],
    ["", "1.18.33", false, "nothing never meets a pin"],
    ["1.18.33", "not-a-version", false, "an unreadable pin refuses rather than passes"],
  ];
  for (const [actual, minimum, meets, why] of table) {
    it(`${actual || '""'} against ${minimum}: ${meets ? "meets" : "does not meet"} — ${why}`, () => {
      expect(meetsMinimumVersion(actual, minimum)).toBe(meets);
    });
  }
});

describe("requireMinimumVersion", () => {
  const withVersion = (version?: string) =>
    negotiate({
      protocolVersion: 1,
      ...(version === undefined ? {} : { agentInfo: { name: "OpenCode", version } }),
    });

  it("lets the pinned build through", () => {
    expect(() => requireMinimumVersion(withVersion("1.18.33"), "1.18.33")).not.toThrow();
  });

  it("refuses an older build naming the harness, both versions and how to upgrade", () => {
    let thrown: unknown;
    try {
      requireMinimumVersion(withVersion("1.17.2"), "1.18.33", {
        harness: "opencode",
        installHint: "npm install -g opencode-ai@latest",
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(HarnessVersionError);
    expect((thrown as Error).message).toBe(
      "opencode 1.17.2 is older than 1.18.33, the oldest version this build supports — upgrade it (npm install -g opencode-ai@latest)",
    );
  });

  it("refuses an agent that will not say its version — a pin that passes on silence is none", () => {
    expect(() => requireMinimumVersion(withVersion(), "1.18.33", { harness: "opencode" })).toThrow(
      "could not confirm the opencode version: it did not report one, and this build needs at least 1.18.33 — upgrade it",
    );
  });

  it("falls back to the agent's own name when the caller gives none", () => {
    expect(() => requireMinimumVersion(withVersion("1.0.0"), "1.18.33")).toThrow(
      /^OpenCode 1\.0\.0 is older than 1\.18\.33/,
    );
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
