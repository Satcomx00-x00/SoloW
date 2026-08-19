import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import {
  STREAM_TICKET_TTL_MS,
  signStreamTicket,
  streamChannel,
  verifyStreamTicket,
} from "./stream.js";

const SECRET = "unit-test-stream-secret";
const NOW = 1_700_000_000_000;

describe("streamChannel", () => {
  it("scopes a task channel to its Workspace", () => {
    expect(streamChannel({ workspaceId: "ws-a", taskId: "task-1" })).toBe("ws:ws-a:task:task-1");
  });

  it("uses the board channel when no task is named", () => {
    expect(streamChannel({ workspaceId: "ws-a", taskId: null })).toBe("ws:ws-a:board");
  });
});

describe("stream tickets", () => {
  it("round-trips claims", () => {
    const ticket = signStreamTicket({ workspaceId: "ws-a", taskId: "task-1" }, SECRET, NOW);
    const res = verifyStreamTicket(ticket, SECRET, NOW + 1);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claims.workspaceId).toBe("ws-a");
    expect(res.claims.taskId).toBe("task-1");
    expect(res.claims.exp).toBe(NOW + STREAM_TICKET_TTL_MS);
  });

  it("rejects a ticket signed with another secret", () => {
    const ticket = signStreamTicket({ workspaceId: "ws-a", taskId: null }, "other-secret", NOW);
    const res = verifyStreamTicket(ticket, SECRET, NOW + 1);
    expect(res).toEqual({ ok: false, error: "ticket_signature_invalid" });
  });

  it("rejects a tampered payload — the tenant key cannot be swapped", () => {
    const ticket = signStreamTicket({ workspaceId: "ws-a", taskId: "task-1" }, SECRET, NOW);
    const [, sig] = ticket.split(".");
    const forged = Buffer.from(
      JSON.stringify({ workspaceId: "ws-b", taskId: "task-1", exp: NOW + 60_000 }),
      "utf8",
    ).toString("base64url");
    const res = verifyStreamTicket(`${forged}.${sig}`, SECRET, NOW + 1);
    expect(res).toEqual({ ok: false, error: "ticket_signature_invalid" });
  });

  it("rejects an expired ticket", () => {
    const ticket = signStreamTicket({ workspaceId: "ws-a", taskId: "task-1" }, SECRET, NOW, 1_000);
    const res = verifyStreamTicket(ticket, SECRET, NOW + 1_001);
    expect(res).toEqual({ ok: false, error: "ticket_expired" });
  });

  it("rejects malformed tickets", () => {
    for (const bad of ["", "no-dot", ".sig", "payload."]) {
      expect(verifyStreamTicket(bad, SECRET, NOW).ok).toBe(false);
    }
  });

  it("rejects a correctly signed ticket whose claims are not a ticket", () => {
    // Signature valid (same secret) but the claims are junk — the shape check must still bite.
    const payload = Buffer.from(JSON.stringify({ nope: true }), "utf8").toString("base64url");
    const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
    const res = verifyStreamTicket(`${payload}.${sig}`, SECRET, NOW + 1);
    expect(res).toEqual({ ok: false, error: "ticket_claims_invalid" });
  });
});
