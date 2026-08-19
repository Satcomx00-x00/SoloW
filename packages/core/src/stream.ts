import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stream subscription tickets (TASK-018 connection auth).
 *
 * The WebSocket hub lives in the orchestrator process, so it cannot read the web app's
 * session cookie. Instead the web API — which *has* already authorized the session and the
 * Workspace — mints a short-lived HMAC-signed ticket naming the exact channel the client may
 * read. The orchestrator verifies the signature and derives the channel from the ticket's own
 * claims, never from a client-supplied parameter, so a client cannot subscribe to another
 * Workspace's stream by editing the query string (Principle V).
 *
 * Exported from `@gatecontrol/core/stream` rather than the package barrel: it imports
 * `node:crypto` and must never be pulled into the browser bundle.
 */

/** Default ticket lifetime. Long enough to open a socket, short enough to be uninteresting. */
export const STREAM_TICKET_TTL_MS = 60_000;

export interface StreamTicketClaims {
  workspaceId: string;
  /** Task-scoped stream, or `null` for the Workspace-wide board channel. */
  taskId: string | null;
  /** Expiry, unix milliseconds. */
  exp: number;
}

export type StreamTicketError =
  | "ticket_malformed"
  | "ticket_signature_invalid"
  | "ticket_expired"
  | "ticket_claims_invalid";

const b64url = (buf: Buffer): string => buf.toString("base64url");

function sign(payload: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(payload).digest());
}

/** The channel a set of claims grants access to. Web and orchestrator agree via this function. */
export function streamChannel(claims: Pick<StreamTicketClaims, "workspaceId" | "taskId">): string {
  return claims.taskId
    ? `ws:${claims.workspaceId}:task:${claims.taskId}`
    : `ws:${claims.workspaceId}:board`;
}

/** Mint a ticket. `now` is injected so callers (and tests) control the clock. */
export function signStreamTicket(
  claims: Omit<StreamTicketClaims, "exp">,
  secret: string,
  now: number,
  ttlMs: number = STREAM_TICKET_TTL_MS,
): string {
  const full: StreamTicketClaims = { ...claims, exp: now + ttlMs };
  const payload = b64url(Buffer.from(JSON.stringify(full), "utf8"));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a ticket and return its claims. Signature is checked before the claims are trusted,
 * and the comparison is constant-time so a forged ticket cannot be tuned byte by byte.
 */
export function verifyStreamTicket(
  ticket: string,
  secret: string,
  now: number,
): { ok: true; claims: StreamTicketClaims } | { ok: false; error: StreamTicketError } {
  const dot = ticket.indexOf(".");
  if (dot <= 0 || dot === ticket.length - 1) return { ok: false, error: "ticket_malformed" };
  const payload = ticket.slice(0, dot);
  const provided = Buffer.from(ticket.slice(dot + 1));
  const expected = Buffer.from(sign(payload, secret));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, error: "ticket_signature_invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "ticket_malformed" };
  }
  if (!isClaims(parsed)) return { ok: false, error: "ticket_claims_invalid" };
  if (parsed.exp <= now) return { ok: false, error: "ticket_expired" };
  return { ok: true, claims: parsed };
}

function isClaims(value: unknown): value is StreamTicketClaims {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c["workspaceId"] === "string" &&
    c["workspaceId"].length > 0 &&
    (c["taskId"] === null || (typeof c["taskId"] === "string" && c["taskId"].length > 0)) &&
    typeof c["exp"] === "number" &&
    Number.isFinite(c["exp"])
  );
}
