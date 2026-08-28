/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProtocol } from "@solow/contracts";
import { signStreamTicket } from "@solow/core/stream";
import { agentCatalog, agentProfile, encryptSecret, secret, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, eq } from "drizzle-orm";
import { handleAnnouncePost, handleProbePost } from "./index.js";

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

/**
 * `POST /probe-agent` — "does this Agent Profile actually work?", asked before a Task depends on
 * the answer (2026-08-28).
 *
 * Two rules carry the weight. The tenancy one is the same as `/announce`: the Workspace comes
 * from the signed ticket, never the body, so a caller cannot probe another tenant's agent. The
 * other is specific to this route and is why it is authenticated at all — it launches a binary
 * an Owner named, with that Owner's credential in its environment. An unauthenticated version
 * would be remote command execution with a wallet attached.
 */
describe("handleProbePost", () => {
  const SECRET = "probe-secret";
  const NOW = 1_700_000_000_000;
  let db: TestDb;

  beforeAll(() => {
    // Set here rather than inherited from whichever test file ran first: `prepareAgentEnv`
    // decrypts the Profile's Secret, and a suite that only passes after a neighbour's
    // `beforeAll` is a suite that fails when run alone.
    process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });

  beforeEach(() => {
    db = createTestDb();
  });

  const deps = () => ({ db, now: () => NOW, streamSecret: SECRET });

  const post = (body: unknown) =>
    handleProbePost(
      new Request("http://orchestrator/probe-agent", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      deps(),
    );

  const ticketFor = (workspaceId: string) =>
    signStreamTicket({ workspaceId, taskId: null }, SECRET, NOW);

  /** A fake agent: a shell script doing exactly what the test needs (Principle VI). */
  async function fakeAgent(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "solow-probe-route-"));
    const path = join(dir, "fake-agent");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  async function seedProfile(
    workspaceId: string,
    opts: { command: string; protocol: AgentProtocol; profileId?: string },
  ): Promise<string> {
    const profileId = opts.profileId ?? `ap-${workspaceId}`;
    await db.insert(workspace).values({ id: workspaceId, name: "WS", ownerUserId: "owner" });
    await db.insert(secret).values({
      id: `sec-${workspaceId}`,
      workspaceId,
      name: "sub",
      kind: "subscription_token",
      ciphertext: encryptSecret("oauth-token"),
    });
    await db.insert(agentCatalog).values({
      id: `cat-${workspaceId}`,
      workspaceId,
      key: "probe-me",
      displayName: "Probe Me",
      protocol: opts.protocol,
      command: opts.command,
      argsTemplate: [],
      subscriptionEnvVar: "SUB_TOKEN",
      meteredEnvVar: "API_KEY",
    });
    await db.insert(agentProfile).values({
      id: profileId,
      workspaceId,
      name: "Mine",
      agentCatalogId: `cat-${workspaceId}`,
      authMode: "subscription",
      secretId: `sec-${workspaceId}`,
      concurrencyCap: 1,
    });
    return profileId;
  }

  it("refuses a ticket it cannot verify, before touching the database", async () => {
    const res = await post({
      ticket: signStreamTicket({ workspaceId: "ws-1", taskId: null }, "other-secret", NOW),
      agentProfileId: "ap-ws-1",
    });

    expect(res.status).toBe(401);
  });

  it("reads a Profile from another Workspace as absent, never as someone else's agent", async () => {
    // Principle V, at the one route that would otherwise start a stranger's binary.
    await seedProfile("ws-1", { command: "/bin/true", protocol: "cli_passthrough" });

    const res = await post({ ticket: ticketFor("ws-2"), agentProfileId: "ap-ws-1" });

    expect(res.status).toBe(404);
  });

  it("reports a working agent, and caches what it advertises", async () => {
    const command = await fakeAgent("sleep 5");
    const id = await seedProfile("ws-1", { command, protocol: "cli_passthrough" });

    const res = await post({ ticket: ticketFor("ws-1"), agentProfileId: id });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reason: null });
  });

  it("answers with a readable reason rather than an error status when the agent is missing", async () => {
    // The failure an Owner actually hits. A 500 here would put the reason in a server log
    // instead of on the screen of the person who can fix it.
    const id = await seedProfile("ws-1", {
      command: "/nonexistent/agent-binary",
      protocol: "cli_passthrough",
    });

    const res = await post({ ticket: ticketFor("ws-1"), agentProfileId: id });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("installed and on PATH");
  });

  it("fills the capability cache from the handshake, with no run needed", async () => {
    // The half of this feature that is not about failure: the pin pickers were empty until a
    // first Task completed, so the ordering was "commit work, then find out what you could
    // have chosen". A probe inverts it.
    const command = await fakeAgent(`
      while IFS= read -r line; do
        case "$line" in
          *'"initialize"'*) printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n' ;;
          *'"session/new"'*) printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1","configOptions":[{"id":"model","category":"model","options":[{"value":"m-a"},{"value":"m-b"}]},{"id":"mode","category":"mode","options":[{"value":"plan"}]}]}}\n' ;;
        esac
      done`);
    const id = await seedProfile("ws-1", { command, protocol: "acp" });

    const res = await post({ ticket: ticketFor("ws-1"), agentProfileId: id });

    expect(await res.json()).toMatchObject({
      ok: true,
      capabilities: { models: ["m-a", "m-b"], modes: ["plan"] },
    });
    const [row] = await db
      .select()
      .from(agentCatalog)
      .where(and(eq(agentCatalog.workspaceId, "ws-1"), eq(agentCatalog.id, "cat-ws-1")))
      .limit(1);
    expect(row?.capabilities).toEqual({ models: ["m-a", "m-b"], modes: ["plan"] });
  });
});
