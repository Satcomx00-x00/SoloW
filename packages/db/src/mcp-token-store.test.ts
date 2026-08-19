import { describe, expect, it } from "bun:test";
import { generateMcpToken, hashMcpToken, mcpTokenHashEquals } from "./mcp-token-store.js";

/**
 * Token generation and hashing (issue #16, Principle IV). The properties under test are the ones
 * that make storing a hash safe: the value is unguessable, the hash is one-way and stable, and
 * the stored prefix reveals nothing usable.
 */

describe("generateMcpToken", () => {
  it("issues a distinct value every time", () => {
    const values = new Set(Array.from({ length: 200 }, () => generateMcpToken().value));
    expect(values.size).toBe(200);
  });

  it("carries a recognisable prefix so a leaked token is greppable", () => {
    expect(generateMcpToken().value.startsWith("gcmcp_")).toBe(true);
  });

  it("returns a hash that matches hashing the value, and never the value itself", () => {
    const generated = generateMcpToken();
    expect(generated.hash).toBe(hashMcpToken(generated.value));
    expect(generated.hash).not.toBe(generated.value);
    expect(generated.hash).not.toContain(generated.value);
  });

  it("stores a prefix short enough to be useless on its own", () => {
    const generated = generateMcpToken();
    expect(generated.value.startsWith(generated.prefix)).toBe(true);
    // The displayed prefix must be a small fraction of the value — enough to tell two tokens
    // apart in a list, nowhere near enough to reconstruct one.
    expect(generated.prefix.length).toBeLessThan(generated.value.length / 2);
  });

  it("carries enough entropy that the secret part is not brute-forceable", () => {
    // 32 random bytes, base64url — ~43 characters after the prefix.
    const secretPart = generateMcpToken().value.slice("gcmcp_".length);
    expect(secretPart.length).toBeGreaterThanOrEqual(40);
  });
});

describe("hashMcpToken", () => {
  it("is deterministic, so a presented token can be looked up by hash", () => {
    expect(hashMcpToken("gcmcp_example")).toBe(hashMcpToken("gcmcp_example"));
  });

  it("differs for different inputs", () => {
    expect(hashMcpToken("gcmcp_a")).not.toBe(hashMcpToken("gcmcp_b"));
  });

  it("produces a fixed-length hex digest regardless of input length", () => {
    expect(hashMcpToken("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpToken("x".repeat(10_000))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mcpTokenHashEquals", () => {
  it("matches identical hashes and rejects different ones", () => {
    const hash = hashMcpToken("gcmcp_example");
    expect(mcpTokenHashEquals(hash, hash)).toBe(true);
    expect(mcpTokenHashEquals(hash, hashMcpToken("gcmcp_other"))).toBe(false);
  });

  it("rejects a length mismatch instead of throwing", () => {
    // timingSafeEqual throws on unequal lengths; the guard must absorb that, because a truncated
    // value arriving from a client would otherwise become a 500 rather than a clean refusal.
    expect(mcpTokenHashEquals(hashMcpToken("a"), "short")).toBe(false);
  });
});
