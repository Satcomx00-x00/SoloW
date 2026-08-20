import { describe, expect, it } from "bun:test";
import type { AcpPermissionRequest } from "@gatecontrol/acp";
import { headlessFallbackPolicy, PermissionInbox } from "./permissions.js";

/**
 * AC-4's inbox. The questions worth pinning down are all about *who decided*: an operator who
 * answers must win, an unattended run must not hang, and either way the answer has to say which
 * of the two it was — a session log that cannot distinguish them is not an audit trail.
 */

const OPTIONS = [
  { optionId: "always", name: "Allow for the rest of the session", kind: "allow_always" },
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

function request(over: Partial<AcpPermissionRequest> = {}): AcpPermissionRequest {
  return {
    requestId: "req-1",
    sessionId: "acp-session-1",
    toolCallId: "call-1",
    title: "Write .env",
    kind: "edit",
    options: OPTIONS,
    ...over,
  };
}

describe("headlessFallbackPolicy", () => {
  it("refuses by default, even when the agent offered an allow", () => {
    // AC-4: surfaced to the operator *rather than silently granting it*. An auto-grant on a
    // timer is a silent grant with a delay in front of it, and it is a wider posture than the
    // Claude Code path's `acceptEdits`, which stops for everything that is not a file edit.
    expect(headlessFallbackPolicy(OPTIONS)).toEqual({
      outcome: "cancelled",
      optionId: null,
      decidedBy: "policy",
    });
  });

  it("grants only when a deployment has asked for that posture by name", () => {
    expect(headlessFallbackPolicy(OPTIONS, "allow_once")).toEqual({
      outcome: "selected",
      optionId: "once",
      decidedBy: "policy",
    });
  });

  it("takes the blanket allow only when the permissive posture has nothing narrower", () => {
    // `allow_always` grants every future action of its kind for the rest of the session, so it
    // is the last resort even for a deployment that opted in.
    expect(
      headlessFallbackPolicy([OPTIONS[0] as (typeof OPTIONS)[number]], "allow_once"),
    ).toMatchObject({ optionId: "always" });
  });

  it("declines when the agent offered nothing but refusals", () => {
    expect(
      headlessFallbackPolicy([{ optionId: "no", name: "No", kind: "reject_once" }], "allow_once"),
    ).toEqual({ outcome: "cancelled", optionId: null, decidedBy: "policy" });
  });

  it("declines when the agent offered no options at all", () => {
    expect(headlessFallbackPolicy([], "allow_once")).toMatchObject({ outcome: "cancelled" });
  });
});

describe("PermissionInbox", () => {
  it("resolves with the operator's choice, recorded as theirs", async () => {
    const inbox = new PermissionInbox(10_000);
    const pending = inbox.ask(request());
    expect(inbox.size).toBe(1);

    expect(inbox.answer("req-1", "no")).toBe("answered");
    expect(await pending).toEqual({ outcome: "selected", optionId: "no", decidedBy: "operator" });
    expect(inbox.size).toBe(0);
  });

  it("refuses when nobody answers before the deadline", async () => {
    const inbox = new PermissionInbox(5);
    // A run nobody is watching neither hangs a durable step for days nor helps itself to the
    // permission: it is refused, and the record says the policy — not a person — decided.
    expect(await inbox.ask(request())).toEqual({
      outcome: "cancelled",
      optionId: null,
      decidedBy: "policy",
    });
  });

  it("grants on the deadline only for a deployment that configured that posture", async () => {
    const inbox = new PermissionInbox(5, "allow_once");
    expect(await inbox.ask(request())).toEqual({
      outcome: "selected",
      optionId: "once",
      decidedBy: "policy",
    });
  });

  it("an operator answering first beats the deadline", async () => {
    const inbox = new PermissionInbox(50);
    const pending = inbox.ask(request());
    inbox.answer("req-1", "no");
    const resolved = await pending;
    expect(resolved.decidedBy).toBe("operator");
    // ...and the fallback timer must not then fire and resolve it a second time.
    await new Promise((r) => setTimeout(r, 80));
    expect(inbox.size).toBe(0);
  });

  it("refuses an option the agent never offered, and says that is why", async () => {
    // The UI renders only the agent's own options; an id from anywhere else is a bug or an
    // attempt, and inventing a permission is precisely what AC-2's rule forbids elsewhere.
    const inbox = new PermissionInbox(10_000);
    const pending = inbox.ask(request());
    expect(inbox.answer("req-1", "sudo")).toBe("option_not_offered");
    inbox.close();
    expect((await pending).outcome).toBe("cancelled");
  });

  it("tells a stale answer apart from an unoffered option", async () => {
    // Two different things to say to the operator: the question is over, or the click did not
    // match anything on the table. Reporting either as "no agent is running" was the old bug.
    const inbox = new PermissionInbox(10_000);
    expect(inbox.answer("req-never-asked", "once")).toBe("not_pending");
    const pending = inbox.ask(request());
    inbox.answer("req-1", "once");
    await pending;
    expect(inbox.answer("req-1", "no")).toBe("not_pending");
  });

  it("settles everything outstanding when the run ends, so no turn is left hanging", async () => {
    const inbox = new PermissionInbox(10_000);
    const a = inbox.ask(request({ requestId: "req-a" }));
    const b = inbox.ask(request({ requestId: "req-b" }));

    inbox.close();

    expect(await a).toMatchObject({ outcome: "cancelled", decidedBy: "policy" });
    expect(await b).toMatchObject({ outcome: "cancelled" });
    expect(inbox.size).toBe(0);
  });
});
