import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dbEnv } from "./env.js";

/**
 * Secret encryption at rest (constitution Principle IV / spec F17).
 *
 * AES-256-GCM. The key comes from the validated env module only. Ciphertext is stored
 * as `iv.tag.data` (base64 parts). The plaintext is NEVER returned to a DTO, log, span,
 * or WebSocket event — only two named entry points yield plaintext, each solely for its own
 * caller: `decryptForAgentRun` (orchestrator-only, to inject a single credential into an agent
 * process's environment) and `decryptForScmSync` (web layer, to call a GitHub/GitLab API
 * directly from the server process — issue #15). Neither's result is ever mapped into a DTO.
 */

const ALGO = "aes-256-gcm";

function key(): Buffer {
  const raw = Buffer.from(dbEnv().GATECONTROL_SECRET_KEY, "base64");
  if (raw.length !== 32) {
    throw new Error("GATECONTROL_SECRET_KEY must decode to 32 bytes (base64)");
  }
  return raw;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(".");
}

function decrypt(ciphertext: string): string {
  const [ivB64, tagB64, dataB64] = ciphertext.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("malformed secret ciphertext");
  }
  const decipher = createDecipheriv(ALGO, key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Orchestrator-only. Decrypts a stored credential so it can be placed in a single agent
 * process's environment. Do not call from the web/API layer or expose via a DTO.
 */
export function decryptForAgentRun(ciphertext: string): string {
  return decrypt(ciphertext);
}

/**
 * Web layer only, for the SCM integration DAL (issue #15). Decrypts a stored `scm_pat` so the
 * server process can call the GitHub/GitLab API directly with it. The result is passed straight
 * to `@gatecontrol/scm` and discarded — never returned from a DAL function, never mapped into a
 * DTO, never logged.
 */
export function decryptForScmSync(ciphertext: string): string {
  return decrypt(ciphertext);
}
