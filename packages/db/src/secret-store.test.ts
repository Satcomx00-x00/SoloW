/// <reference types="bun-types" />
import { beforeAll, describe, expect, it } from "bun:test";

/**
 * Tests for the AES-256-GCM secret store (Principle IV / spec F17).
 *
 * The env module (`./env.ts`) reads GATECONTROL_SECRET_KEY from process.env and caches the
 * result on first access, so the key MUST be present before @gatecontrol/db is imported. We
 * set it in beforeAll and pull the module in via dynamic import to guarantee that ordering.
 */

type SecretStore = typeof import("./secret-store.js");

let encryptSecret: SecretStore["encryptSecret"];
let decryptForAgentRun: SecretStore["decryptForAgentRun"];

beforeAll(async () => {
  process.env.GATECONTROL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  const mod = await import("./secret-store.js");
  encryptSecret = mod.encryptSecret;
  decryptForAgentRun = mod.decryptForAgentRun;
});

describe("secret store", () => {
  it("round-trips plaintext through encrypt/decrypt", () => {
    const plaintext = "ghp_totally-secret-token-42";
    const ciphertext = encryptSecret(plaintext);

    // Stored shape is iv.tag.data (three base64 parts) and never the raw plaintext.
    expect(ciphertext.split(".")).toHaveLength(3);
    expect(ciphertext).not.toContain(plaintext);

    expect(decryptForAgentRun(ciphertext)).toBe(plaintext);
  });

  it("round-trips multibyte unicode plaintext", () => {
    const unicode = "clé-secrète-🔐-Ω";
    expect(decryptForAgentRun(encryptSecret(unicode))).toBe(unicode);
  });

  it("produces different ciphertext for the same plaintext (random IV)", () => {
    const plaintext = "same-input-value";
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);

    expect(a).not.toBe(b);
    // The IV segment (first part) is what randomizes, so it must differ.
    expect(a.split(".")[0]).not.toBe(b.split(".")[0]);

    // Both still decrypt back to the identical plaintext.
    expect(decryptForAgentRun(a)).toBe(plaintext);
    expect(decryptForAgentRun(b)).toBe(plaintext);
  });

  it("throws when the data segment is tampered with (GCM auth tag mismatch)", () => {
    const ciphertext = encryptSecret("tamper-me");
    const [iv, tag, data] = ciphertext.split(".") as [string, string, string];

    // Flip one character in the data segment to a *different* valid base64 char so the
    // ciphertext is still well-formed but no longer authenticates.
    const chars = data.split("");
    const idx = 0;
    chars[idx] = chars[idx] === "A" ? "B" : "A";
    const tampered = [iv, tag, chars.join("")].join(".");

    expect(tampered).not.toBe(ciphertext);
    expect(() => decryptForAgentRun(tampered)).toThrow();
  });

  it("throws when the auth tag is tampered with", () => {
    const ciphertext = encryptSecret("tamper-tag");
    const [iv, tag, data] = ciphertext.split(".") as [string, string, string];
    const chars = tag.split("");
    chars[0] = chars[0] === "A" ? "B" : "A";
    const tampered = [iv, chars.join(""), data].join(".");

    expect(() => decryptForAgentRun(tampered)).toThrow();
  });

  it("throws on a malformed ciphertext with missing segments", () => {
    expect(() => decryptForAgentRun("only-one-segment")).toThrow(/malformed secret ciphertext/);
    expect(() => decryptForAgentRun("iv.tag")).toThrow(/malformed secret ciphertext/);
    expect(() => decryptForAgentRun("")).toThrow(/malformed secret ciphertext/);
  });
});
