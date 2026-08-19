import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * MCP token generation and verification (issue #16, Principle IV).
 *
 * The counterpart to `secret-store.ts`, and deliberately the opposite shape: a Secret is
 * *encrypted* because something later needs its plaintext, while an MCP token is *hashed*
 * because nothing ever does. There is no `decrypt`-equivalent in this module and there should
 * never be one — a lost token is reissued, not recovered.
 */

/** Distinguishes a GateControl token at a glance, and gives secret scanners something to match. */
const PREFIX = "gcmcp_";

/** Characters of the value kept in the clear, so a token list is legible without being reversible. */
const PREFIX_DISPLAY_LENGTH = PREFIX.length + 6;

export interface GeneratedMcpToken {
  /** Shown to the Owner exactly once, then unrecoverable. */
  value: string;
  /** SHA-256 of `value`, hex — what actually gets persisted. */
  hash: string;
  /** Leading characters of `value`, safe to store and display. */
  prefix: string;
}

/**
 * 256 bits from a CSPRNG, base64url so it survives a shell, an env var, and a JSON config file
 * without escaping. Entropy is what makes a plain SHA-256 the right hash here — there is no
 * password to guess.
 */
export function generateMcpToken(): GeneratedMcpToken {
  const value = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    value,
    hash: hashMcpToken(value),
    prefix: value.slice(0, PREFIX_DISPLAY_LENGTH),
  };
}

export function hashMcpToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two token hashes.
 *
 * The database lookup is by hash and therefore already constant-ish, but any place that compares
 * a derived hash to a stored one should not leak position through early exit — this exists so
 * callers have no reason to reach for `===`.
 */
export function mcpTokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
