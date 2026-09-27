/// <reference types="bun-types" />
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
  encryptSecret,
  executorProfile,
  harnessCatalog,
  integration,
  repository,
  secret,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";
import {
  getSyncStatus,
  getWorkspace,
  getWorkspaceFlags,
  getWorkspaceSetup,
  renameWorkspace,
} from "./workspace.js";

/**
 * The Workspace, as something an Owner can read and act on (2026-08-28).
 *
 * The setup state is the part worth pinning hardest, because it replaced a fixture that lied.
 * A local install used to arrive holding two invented companies, each with a credential, an
 * Harness Profile, an Executor and a repository that never existed — so the product looked
 * configured on first launch and the real gap stayed hidden. Everything below is about the
 * checklist telling the truth about rows that are actually there.
 */

let db: TestDb;

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

beforeEach(() => {
  db = createTestDb();
});

/** A Workspace with nothing but itself — what a real sign-up actually produces. */
async function bareWorkspace(name = "Bare") {
  const [ws] = await db.insert(workspace).values({ name, ownerUserId: "owner-1" }).returning();
  if (!ws) throw new Error("failed to insert workspace");
  return ws.id;
}

const stepsOf = async (workspaceId: string) => {
  const result = await getWorkspaceSetup(ctxFor(db, workspaceId));
  if (!result.ok) throw new Error(`setup failed: ${result.error}`);
  return result.data;
};

const step = (data: Awaited<ReturnType<typeof stepsOf>>, key: string) =>
  data.steps.find((s) => s.key === key);

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

describe("getWorkspaceSetup", () => {
  it("reports a bare Workspace as unready, naming what it lacks", async () => {
    // The state a real sign-up leaves behind, and the one the retired fixture hid: no
    // credential, no profile, no executor, no repository. The core loop is *not* among them any
    // more — flags default ON (constitution v1.5.0), so a fresh Workspace arrives with that step
    // already done and what it lacks is only ever rows somebody has to create.
    const id = await bareWorkspace();

    const data = await stepsOf(id);

    expect(data.ready).toBe(false);
    expect(step(data, "workspace")?.done).toBe(true);
    expect(step(data, "core-loop")?.done).toBe(true);
    for (const key of ["agents", "secret", "agent-profile", "executor", "repository"]) {
      expect(step(data, key)?.done).toBe(false);
    }
  });

  it("says a Harness Profile is waiting on a credential rather than offering a dead action", async () => {
    // A Profile binds a harness to a Secret, so a form opened before one exists has an empty
    // picker. Naming the missing thing is a better answer than a button that cannot work.
    const id = await bareWorkspace();

    const data = await stepsOf(id);

    expect(step(data, "agent-profile")?.blockedBy).toBe("secret");
  });

  it("stops blocking the Profile step once a credential exists", async () => {
    const id = await bareWorkspace();
    await db.insert(secret).values({
      workspaceId: id,
      name: "token",
      kind: "api_key",
      ciphertext: "cipher",
    });

    const data = await stepsOf(id);

    expect(step(data, "secret")?.done).toBe(true);
    expect(step(data, "secret")?.detail).toBe("1 secret");
    expect(step(data, "agent-profile")?.blockedBy).toBeNull();
  });

  it("counts what exists, in words rather than as a bare number", async () => {
    const id = await bareWorkspace();
    await db.insert(repository).values([
      { workspaceId: id, name: "one", source: "local_path", location: "/tmp/one" },
      { workspaceId: id, name: "two", source: "local_path", location: "/tmp/two" },
    ]);

    const data = await stepsOf(id);

    // "repositories", not "repositorys" — the plural is given, not guessed from the singular.
    expect(step(data, "repository")?.detail).toBe("2 repositories");
  });

  it("is ready only when every step is, including the flag the core loop hides behind", async () => {
    /*
     * `ff-core-program` defaults ON now, so the direction of this test is reversed: it used to
     * prove a fully-configured Workspace stays unready until the flag is switched on, and it
     * proves the same coupling from the other side — a fully-configured Workspace goes *back* to
     * unready the moment somebody kills that flag. The step exists for the kill switch, which is
     * the case where a Workspace has everything and still refuses to run a Task.
     */
    const graph = await seedWorkspaceGraph(db, "full");
    await db.insert(secret).values({
      workspaceId: graph.workspaceId,
      name: "token",
      kind: "api_key",
      ciphertext: "cipher",
    });

    const before = await stepsOf(graph.workspaceId);
    expect(step(before, "core-loop")?.done).toBe(true);
    expect(before.ready).toBe(true);

    await db
      .update(workspace)
      .set({ enabledFlags: { "ff-core-program": false } })
      .where(eq(workspace.id, graph.workspaceId));

    const after = await stepsOf(graph.workspaceId);
    expect(step(after, "core-loop")?.done).toBe(false);
    expect(after.ready).toBe(false);
  });

  it("goes back to unready when something it counted is deleted", async () => {
    /*
     * Why this is derived rather than a stored "completed" flag. A checklist that remembered
     * being finished would keep saying so after the Executor it counted was removed — which is
     * the moment somebody most needs to be told otherwise.
     */
    const graph = await seedWorkspaceGraph(db, "full");
    await db.insert(secret).values({
      workspaceId: graph.workspaceId,
      name: "token",
      kind: "api_key",
      ciphertext: "cipher",
    });
    // No flag write: it defaults ON, so a Workspace with every row is ready as it stands.
    expect((await stepsOf(graph.workspaceId)).ready).toBe(true);

    await db.delete(executorProfile).where(eq(executorProfile.workspaceId, graph.workspaceId));

    const after = await stepsOf(graph.workspaceId);
    expect(after.ready).toBe(false);
    expect(step(after, "executor")?.done).toBe(false);
  });

  it("counts only the caller's own rows", async () => {
    // A neighbour's Secret must never satisfy this Workspace's checklist.
    const mine = await bareWorkspace("Mine");
    const theirs = await bareWorkspace("Theirs");
    await db.insert(secret).values({
      workspaceId: theirs,
      name: "not-mine",
      kind: "api_key",
      ciphertext: "cipher",
    });
    await db.insert(harnessCatalog).values({
      workspaceId: theirs,
      key: "claude_code",
      displayName: "Claude Code",
      protocol: "claude_code_stream_json",
      command: "claude",
      subscriptionEnvVar: "SUB",
      meteredEnvVar: "API",
    });

    const data = await stepsOf(mine);

    expect(step(data, "secret")?.done).toBe(false);
    expect(step(data, "agents")?.done).toBe(false);
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
