/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import { encryptSecret, integration, repository, secret, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { ctxFor } from "./test-fixtures.js";
import {
  getHistoryRetention,
  getSyncStatus,
  getWorkspace,
  getWorkspaceFlags,
  previewHistoryRetention,
  renameWorkspace,
  setHistoryRetention,
} from "./workspace.js";

/**
 * The Workspace, as something an Owner can read and act on (2026-08-28).
 *
 * Its setup state — the part that replaced a fixture that lied — is pinned in `setup.test.ts`,
 * beside the guided setup that now owns it.
 */

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
});

/** A Workspace with nothing but itself — what a real sign-up actually produces. */
async function bareWorkspace(name = "Bare") {
  const [ws] = await db.insert(workspace).values({ name, ownerUserId: "owner-1" }).returning();
  if (!ws) throw new Error("failed to insert workspace");
  return ws.id;
}

describe("getWorkspace", () => {
  it("reads the caller's own Workspace", async () => {
    const id = await bareWorkspace("Mine");

    const result = await getWorkspace(ctxFor(db, id));

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.name).toBe("Mine");
  });

  it("does not read another tenant's Workspace", async () => {
    // Principle V, at the one read whose whole subject is the tenant itself.
    const mine = await bareWorkspace("Mine");
    const theirs = await bareWorkspace("Theirs");

    const result = await getWorkspace(ctxFor(db, mine));

    expect(result.ok && result.data.id).toBe(mine);
    expect(result.ok && result.data.id).not.toBe(theirs);
  });
});

describe("renameWorkspace", () => {
  it("renames the caller's own Workspace and leaves every other one alone", async () => {
    const mine = await bareWorkspace("Before");
    const theirs = await bareWorkspace("Untouched");

    const result = await renameWorkspace(ctxFor(db, mine), { name: "After" });

    expect(result.ok && result.data.name).toBe("After");
    const [other] = await db.select().from(workspace).where(eq(workspace.id, theirs));
    expect(other?.name).toBe("Untouched");
  });
});

describe("getSyncStatus reports the repository that is furthest behind", () => {
  /** A real Integration to hang repositories off — the FK is what makes one "linked". */
  async function integrationFor(workspaceId: string): Promise<string> {
    const [token] = await db
      .insert(secret)
      .values({
        workspaceId,
        name: "pat",
        kind: "scm_pat",
        ciphertext: encryptSecret("glpat-fixture"),
      })
      .returning();
    const [row] = await db
      .insert(integration)
      .values({ workspaceId, provider: "github", secretId: token?.id ?? "" })
      .returning();
    if (!row) throw new Error("failed to insert integration");
    return row.id;
  }

  /** A linked repository — the only kind a poll has anything to do for. */
  async function linked(
    workspaceId: string,
    integrationId: string,
    over: {
      issuesSyncedAt?: string | null;
      syncStaleSince?: string;
      syncStaleReason?: string;
    } = {},
  ) {
    await db.insert(repository).values({
      workspaceId,
      name: `repo-${Math.random().toString(36).slice(2, 8)}`,
      source: "remote_url",
      location: "https://example.test/acme/gate.git",
      integrationId,
      externalFullName: "acme/gate",
      ...over,
    });
  }

  it("answers zero repositories for a Workspace with nothing linked", async () => {
    const wsId = await bareWorkspace();

    const result = await getSyncStatus(ctxFor(db, wsId));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      repositories: 0,
      syncedAt: null,
      stale: 0,
      staleReason: null,
    });
  });

  it("reports the oldest watermark, not the newest", async () => {
    const wsId = await bareWorkspace();
    const int = await integrationFor(wsId);
    await linked(wsId, int, { issuesSyncedAt: "2026-09-01T12:00:00.000Z" });
    await linked(wsId, int, { issuesSyncedAt: "2026-09-01T09:00:00.000Z" });

    const result = await getSyncStatus(ctxFor(db, wsId));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "Synced just now" beside a repository three hours behind is a bar that lies in exactly the
    // situation it exists for.
    expect(result.data.syncedAt).toBe("2026-09-01T09:00:00.000Z");
  });

  it("answers unknown when any repository has never been read", async () => {
    const wsId = await bareWorkspace();
    const int = await integrationFor(wsId);
    await linked(wsId, int, { issuesSyncedAt: "2026-09-01T12:00:00.000Z" });
    await linked(wsId, int, { issuesSyncedAt: null });

    const result = await getSyncStatus(ctxFor(db, wsId));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // An age alongside rows that do not exist yet would be a claim about nothing.
    expect(result.data.syncedAt).toBeNull();
    expect(result.data.repositories).toBe(2);
  });

  it("counts the repositories that backed off, and says why one of them did", async () => {
    const wsId = await bareWorkspace();
    const int = await integrationFor(wsId);
    await linked(wsId, int, { issuesSyncedAt: "2026-09-01T12:00:00.000Z" });
    await linked(wsId, int, {
      issuesSyncedAt: "2026-09-01T11:00:00.000Z",
      syncStaleSince: "2026-09-01T11:05:00.000Z",
      syncStaleReason: "the provider is rate limiting this connection",
    });

    const result = await getSyncStatus(ctxFor(db, wsId));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stale).toBe(1);
    expect(result.data.staleReason).toContain("rate limiting");
  });

  it("never counts another Workspace's repositories", async () => {
    const mine = await bareWorkspace("Mine");
    const theirs = await bareWorkspace("Theirs");
    await linked(mine, await integrationFor(mine), {
      issuesSyncedAt: "2026-09-01T12:00:00.000Z",
    });
    await linked(theirs, await integrationFor(theirs), {
      syncStaleSince: "2026-09-01T11:00:00.000Z",
      syncStaleReason: "boom",
    });

    const result = await getSyncStatus(ctxFor(db, mine));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.repositories).toBe(1);
    expect(result.data.stale).toBe(0);
  });
});

/**
 * Reading a Workspace's flag overrides (constitution v1.5.0).
 *
 * This is the web app's half of the boundary the orchestrator's `loadTaskRunContext` owns on the
 * other side, and the flip to default-ON reversed what its failure mode buys. It used to resolve
 * an unreadable column to "no overrides", which meant everything OFF — fail-closed. The same
 * code now means everything ON.
 *
 * That was an accepted trade rather than an oversight (see the function's own comment), so it is
 * pinned here deliberately: if the shape of this ever changes, it should change because someone
 * decided to, not because a `?? {}` moved.
 */
describe("getWorkspaceFlags", () => {
  const overridesFor = async (stored: unknown) => {
    const [ws] = await db
      .insert(workspace)
      .values({ name: "flags", ownerUserId: "owner-flags" })
      .returning();
    if (!ws) throw new Error("failed to insert workspace");
    await db
      .update(workspace)
      .set({ enabledFlags: stored as Record<string, boolean> | null })
      .where(eq(workspace.id, ws.id));
    return getWorkspaceFlags(db, ws.id);
  };

  it("reads a Workspace that has said nothing as no overrides", async () => {
    // Which, with defaults ON, is every capability available — the state a fresh install is in.
    expect(await overridesFor(null)).toEqual({});
    expect(await overridesFor({})).toEqual({});
  });

  it("carries an explicit false through, because that is the only way off is expressible", async () => {
    expect(await overridesFor({ "ff-workflows": false })).toEqual({ "ff-workflows": false });
  });

  it("carries an explicit true through", async () => {
    expect(await overridesFor({ "ff-mcp": true })).toEqual({ "ff-mcp": true });
  });

  it("drops a key the build does not recognise, rather than passing it on", async () => {
    /*
     * Forward compatibility in the one direction that matters: a column written by a newer build
     * that knows a flag this one does not must not put an unknown key into the context, where
     * `isEnabled` would index `FLAGS` with it. The row is left intact — downgrading is not a
     * reason to lose the newer build's setting.
     */
    expect(await overridesFor({ "ff-from-the-future": false, "ff-mcp": false })).toEqual({
      "ff-mcp": false,
    });
  });

  it("drops a non-boolean value rather than coercing it", async () => {
    // `"false"` is truthy. Guessing what a hand-edited row meant is worse than falling through
    // to the registry default, which is a decision somebody actually made.
    expect(await overridesFor({ "ff-mcp": "false" })).toEqual({});
    expect(await overridesFor({ "ff-mcp": 0 })).toEqual({});
  });

  it("reads a column that is not an object at all as no overrides", async () => {
    // A corrupt column must not throw: this runs on the way in to *every* request, so an
    // exception here would take the whole app down rather than one feature.
    expect(await overridesFor("nonsense")).toEqual({});
    expect(await overridesFor(["ff-mcp"])).toEqual({});
  });

  it("reads a Workspace that does not exist as no overrides", async () => {
    expect(await getWorkspaceFlags(db, "no-such-workspace")).toEqual({});
  });
});

describe("history retention (Decision 0032)", () => {
  it("starts at the default window, and stores a new one or forever for this Workspace only", async () => {
    const mine = await bareWorkspace("Mine");
    const theirs = await bareWorkspace("Theirs");

    const initial = await getHistoryRetention(ctxFor(db, mine));
    expect(initial.ok && initial.data).toEqual({
      days: 30,
      notice: false,
      defaultDays: 30,
      options: [7, 30, 90, 365],
    });

    const forever = await setHistoryRetention(ctxFor(db, mine), { days: null });
    expect(forever.ok && forever.data.days).toBeNull();
    const week = await setHistoryRetention(ctxFor(db, theirs), { days: 7 });
    expect(week.ok && week.data.days).toBe(7);

    const reread = await getHistoryRetention(ctxFor(db, mine));
    expect(reread.ok && reread.data.days).toBeNull();
  });

  it("asks an upgraded Workspace to choose, and stops asking once anything is saved", async () => {
    // What migration 0049 leaves an existing Workspace with: everything kept, and a question.
    const id = await bareWorkspace();
    await db
      .update(workspace)
      .set({ historyRetentionDays: null, historyRetentionNotice: true })
      .where(eq(workspace.id, id));

    const asked = await getHistoryRetention(ctxFor(db, id));
    expect(asked.ok && asked.data).toMatchObject({ days: null, notice: true });

    // Keeping forever is a choice too: saved, it answers the question without changing the window.
    const kept = await setHistoryRetention(ctxFor(db, id), { days: null });
    expect(kept.ok && kept.data).toMatchObject({ days: null, notice: false });
  });

  it("reads a hand-written value outside the offered windows as the default", async () => {
    const id = await bareWorkspace();
    await db.update(workspace).set({ historyRetentionDays: 12 }).where(eq(workspace.id, id));

    const result = await getHistoryRetention(ctxFor(db, id));
    expect(result.ok && result.data.days).toBe(30);
  });

  it("previews nothing for a Workspace with no finished work", async () => {
    const id = await bareWorkspace();

    const result = await previewHistoryRetention(ctxFor(db, id), { days: 7 });
    expect(result.ok && result.data).toEqual({
      tasks: 0,
      sessions: 0,
      events: 0,
      diffs: 0,
    });
  });
});
