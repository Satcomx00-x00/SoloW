/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { signStreamTicket } from "@gatecontrol/core/stream";
import { handleAnnouncePost } from "./index.js";

/**
 * `POST /announce` — the notification path for a change the API made itself.
 *
 * The hub lives in this process and the web app does not, so a person moving a card told only
 * their own browser. Everything below is about the one rule that keeps that from being a tenancy
 * hole: the Workspace and Task come from the ticket's signed claims, never from the body.
 */
describe("handleAnnouncePost", () => {
  const SECRET = "announce-secret";
  const NOW = 1_700_000_000_000;
  const deps = { now: () => NOW, streamSecret: SECRET };

  const post = (body: unknown) =>
    handleAnnouncePost(
      new Request("http://orchestrator/announce", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      deps,
    );

  const ticketFor = (workspaceId: string, taskId: string | null) =>
    signStreamTicket({ workspaceId, taskId }, SECRET, NOW);

  it("accepts a valid task ticket", async () => {
    const res = await post({ ticket: ticketFor("ws-1", "task-1"), state: "review" });

    expect(res.status).toBe(202);
  });

  it("refuses a ticket it cannot verify", async () => {
    const res = await post({
      ticket: signStreamTicket({ workspaceId: "ws-1", taskId: "task-1" }, "other-secret", NOW),
      state: "review",
    });

    expect(res.status).toBe(401);
  });

  it("refuses an expired ticket", async () => {
    const stale = signStreamTicket(
      { workspaceId: "ws-1", taskId: "task-1" },
      SECRET,
      NOW - 600_000,
    );

    const res = await post({ ticket: stale, state: "review" });

    expect(res.status).toBe(401);
  });

  it("refuses a board-scoped ticket, which names no Task to announce about", async () => {
    const res = await post({ ticket: ticketFor("ws-1", null), state: "review" });

    expect(res.status).toBe(400);
  });

  it("refuses a body that is not a valid announcement", async () => {
    expect((await post({ ticket: ticketFor("ws-1", "task-1"), state: "not-a-state" })).status).toBe(
      400,
    );
    expect((await post({ state: "review" })).status).toBe(400);
  });
});
