/// <reference types="bun-types" />
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { agentCatalog, executorProfile, repository, secret, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";
import { getWorkspace, getWorkspaceSetup, renameWorkspace } from "./workspace.js";

/**
 * The Workspace, as something an Owner can read and act on (2026-08-28).
 *
 * The setup state is the part worth pinning hardest, because it replaced a fixture that lied.
 * A local install used to arrive holding two invented companies, each with a credential, an
 * Agent Profile, an Executor and a repository that never existed — so the product looked
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
    // credential, no profile, no executor, no repository, and the core loop off.
    const id = await bareWorkspace();

    const data = await stepsOf(id);

    expect(data.ready).toBe(false);
    expect(step(data, "workspace")?.done).toBe(true);
    for (const key of [
      "agents",
      "secret",
      "agent-profile",
      "executor",
      "repository",
      "core-loop",
    ]) {
      expect(step(data, key)?.done).toBe(false);
    }
  });

  it("says an Agent Profile is waiting on a credential rather than offering a dead action", async () => {
    // A Profile binds an agent to a Secret, so a form opened before one exists has an empty
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
    // `ff-core-program` ships OFF, which is why a fully-configured Workspace can still refuse to
    // run a Task. It is a step rather than a footnote for exactly that reason.
    const graph = await seedWorkspaceGraph(db, "full");
    await db.insert(secret).values({
      workspaceId: graph.workspaceId,
      name: "token",
      kind: "api_key",
      ciphertext: "cipher",
    });

    const before = await stepsOf(graph.workspaceId);
    expect(before.ready).toBe(false);
    expect(step(before, "core-loop")?.done).toBe(false);

    await db
      .update(workspace)
      .set({ enabledFlags: { "ff-core-program": true } })
      .where(eq(workspace.id, graph.workspaceId));

    const after = await stepsOf(graph.workspaceId);
    expect(step(after, "core-loop")?.done).toBe(true);
    expect(after.ready).toBe(true);
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
    await db
      .update(workspace)
      .set({ enabledFlags: { "ff-core-program": true } })
      .where(eq(workspace.id, graph.workspaceId));
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
    await db.insert(agentCatalog).values({
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
