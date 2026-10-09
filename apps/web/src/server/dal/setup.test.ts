/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import type { HarnessProbeReport } from "@solow/contracts";
import {
  decryptForHarnessRun,
  executorProfile,
  harnessCatalog,
  harnessProfile,
  repository,
  secret,
  session,
  sessionUsage,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { getTaskDefaults } from "./preference.js";
import { connectClaude, getWorkspaceSetup, runSetupTest } from "./setup.js";
import { createTaskRecord } from "./task.js";
import { ctxFor, seedIssue } from "./test-fixtures.js";

/**
 * The guided setup (roadmap E1): connect Claude, choose a repository, try it.
 *
 * Three properties carry it, and each is pinned below. Connecting makes every object a run needs
 * in one step and makes none of them twice. The state is read from the rows on every call, so it
 * is resumable and comes back by itself when something it counted is gone. And "done" means a
 * test run passed for the credential as it is now — a replaced token is an untested one.
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

async function connect(workspaceId: string, billing: "subscription" | "api_key", token: string) {
  const result = await connectClaude(ctxFor(db, workspaceId), { billing, credential: token });
  if (!result.ok) throw new Error(`connect failed: ${result.error}`);
  return result.data.result;
}

async function setupOf(workspaceId: string) {
  const result = await getWorkspaceSetup(ctxFor(db, workspaceId));
  if (!result.ok) throw new Error(`setup failed: ${result.error}`);
  return result.data;
}

const step = (data: Awaited<ReturnType<typeof setupOf>>, key: string) =>
  data.steps.find((s) => s.key === key);

const rows = async (workspaceId: string) => ({
  secrets: await db.select().from(secret).where(eq(secret.workspaceId, workspaceId)),
  profiles: await db
    .select()
    .from(harnessProfile)
    .where(eq(harnessProfile.workspaceId, workspaceId)),
  executors: await db
    .select()
    .from(executorProfile)
    .where(eq(executorProfile.workspaceId, workspaceId)),
});

const PASSED: HarnessProbeReport = {
  ok: true,
  reason: null,
  protocolVersion: null,
  authMethods: [],
  agent: null,
  capabilities: { models: [], modes: [] },
  answered: true,
};

const failedWith = (failure: HarnessProbeReport["failure"]): HarnessProbeReport => ({
  ...PASSED,
  ok: false,
  reason: "the harness's own words, which never reach the screen",
  failure,
  answered: false,
});

/** Spaced a second apart: rows made in one millisecond would tie on `createdAt`, the setup's order. */
let added = 0;
async function addRepository(workspaceId: string, name: string) {
  added += 1;
  await db.insert(repository).values({
    workspaceId,
    name,
    source: "local_path",
    location: `/srv/repos/${name}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, added)).toISOString(),
  });
}

describe("connectClaude", () => {
  it("makes the credential, the Profile, somewhere to run and the new-task defaults in one step", async () => {
    const id = await bareWorkspace();

    const result = await connect(id, "subscription", "sk-ant-oat01-first");

    const { secrets, profiles, executors } = await rows(id);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]?.kind).toBe("subscription_token");
    // Stored encrypted, like every Secret; the value round-trips only through the run-time path.
    expect(secrets[0]?.ciphertext).not.toContain("sk-ant-oat01-first");
    expect(decryptForHarnessRun(secrets[0]?.ciphertext ?? "")).toBe("sk-ant-oat01-first");

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.authMode).toBe("subscription");
    expect(profiles[0]?.secretId).toBe(secrets[0]?.id);
    const [catalog] = await db
      .select()
      .from(harnessCatalog)
      .where(eq(harnessCatalog.id, profiles[0]?.agentCatalogId ?? ""));
    expect(catalog?.key).toBe("claude_code");

    expect(executors).toHaveLength(1);
    expect(executors[0]?.kind).toBe("local");
    expect(result.createdExecutor).toBe(true);

    const defaults = await getTaskDefaults(ctxFor(db, id));
    expect(defaults.ok && defaults.data.defaults).toEqual({
      harnessProfileId: result.harnessProfileId,
      executorProfileId: result.executorProfileId,
    });
  });

  it("replaces the credential when run again, and makes nothing twice", async () => {
    const id = await bareWorkspace();
    const first = await connect(id, "subscription", "token-one");

    const second = await connect(id, "subscription", "token-two");

    const { secrets, profiles, executors } = await rows(id);
    expect(secrets).toHaveLength(1);
    expect(profiles).toHaveLength(1);
    expect(executors).toHaveLength(1);
    expect(second.harnessProfileId).toBe(first.harnessProfileId);
    expect(second.createdExecutor).toBe(false);
    expect(decryptForHarnessRun(secrets[0]?.ciphertext ?? "")).toBe("token-two");
  });

  it("makes a second pair for the other billing mode rather than rewriting the first", async () => {
    // A Profile's billing mode is fixed for life — its finished runs were billed under it — so
    // switching to an API key cannot be an edit of the subscription Profile.
    const id = await bareWorkspace();
    const sub = await connect(id, "subscription", "sub-token");

    const key = await connect(id, "api_key", "sk-ant-api-key");

    const { secrets, profiles, executors } = await rows(id);
    expect(secrets.map((s) => s.kind).sort()).toEqual(["api_key", "subscription_token"]);
    expect(profiles).toHaveLength(2);
    expect(executors).toHaveLength(1);
    expect(key.harnessProfileId).not.toBe(sub.harnessProfileId);
    const defaults = await getTaskDefaults(ctxFor(db, id));
    expect(defaults.ok && defaults.data.defaults.harnessProfileId).toBe(key.harnessProfileId);
  });

  it("keeps an executor the Owner already made, a container first, and changes nothing about it", async () => {
    const id = await bareWorkspace();
    const [local] = await db
      .insert(executorProfile)
      .values({
        workspaceId: id,
        name: "My laptop",
        kind: "local",
        config: { kind: "local", env: {} },
      })
      .returning();
    const dockerConfig = { kind: "docker" as const, image: "my/claude:1", mounts: [], env: {} };
    const [docker] = await db
      .insert(executorProfile)
      .values({ workspaceId: id, name: "Sandbox", kind: "docker", config: dockerConfig })
      .returning();

    const result = await connect(id, "api_key", "sk-ant-key");

    expect(result.createdExecutor).toBe(false);
    expect(result.executorProfileId).toBe(docker?.id ?? "");
    expect(result.executorKind).toBe("docker");
    const { executors } = await rows(id);
    expect(executors.map((e) => e.name).sort()).toEqual(["My laptop", "Sandbox"]);
    expect(executors.find((e) => e.id === local?.id)?.config).toEqual({ kind: "local", env: {} });
  });

  it("never counts another Workspace's executor as somewhere to run", async () => {
    // Principle V: a neighbour's Docker executor must not become this Workspace's default.
    const mine = await bareWorkspace("Mine");
    const theirs = await bareWorkspace("Theirs");
    await db.insert(executorProfile).values({
      workspaceId: theirs,
      name: "Theirs",
      kind: "local",
      config: { kind: "local", env: {} },
    });

    const result = await connect(mine, "subscription", "token");

    expect(result.createdExecutor).toBe(true);
    expect((await rows(mine)).executors).toHaveLength(1);
    expect((await rows(theirs)).executors).toHaveLength(1);
  });
});

describe("getWorkspaceSetup", () => {
  it("reports a bare Workspace as three steps to go, with the test waiting on Claude", async () => {
    const id = await bareWorkspace();

    const data = await setupOf(id);

    expect(data.ready).toBe(false);
    expect(data.coreLoop).toBe(true);
    expect(data.steps.map((s) => s.key)).toEqual(["claude", "repository", "test"]);
    expect(data.steps.every((s) => !s.done)).toBe(true);
    expect(step(data, "test")?.blockedBy).toBe("claude");
    expect(data.agent).toBeNull();
    // No executor yet: connecting will make one on this machine, and the screen says so first.
    expect(data.executorKind).toBeNull();
  });

  it("describes what connecting made, including that it runs unattended on this machine", async () => {
    const id = await bareWorkspace();
    await connect(id, "subscription", "token");

    const data = await setupOf(id);

    expect(step(data, "claude")).toEqual({
      key: "claude",
      done: true,
      detail: "Claude Code · subscription",
      blockedBy: null,
    });
    expect(step(data, "test")?.blockedBy).toBeNull();
    expect(step(data, "test")?.done).toBe(false);
    // The pairing the host-run warning exists for — the screen reads it from here.
    expect(data.executorKind).toBe("local");
    expect(data.agent).toEqual({
      harness: "Claude Code",
      billing: "subscription",
      permissionMode: "bypassPermissions",
    });
  });

  it("names the repositories rather than counting them", async () => {
    const id = await bareWorkspace();
    await addRepository(id, "solow");
    await addRepository(id, "crawler");
    expect(step(await setupOf(id), "repository")?.detail).toBe("solow and crawler");

    await addRepository(id, "docs");
    await addRepository(id, "infra");
    expect(step(await setupOf(id), "repository")?.detail).toBe("solow, crawler and 2 more");
  });

  it("is ready only after a test run passes, and not again once the credential is replaced", async () => {
    const id = await bareWorkspace();
    await connect(id, "subscription", "token-one");
    await addRepository(id, "solow");
    expect((await setupOf(id)).ready).toBe(false);

    await runSetupTest(ctxFor(db, id), async () => PASSED);
    const tested = await setupOf(id);
    expect(step(tested, "test")?.done).toBe(true);
    expect(tested.ready).toBe(true);

    // A new token is an untested token. The pause keeps the two writes in different milliseconds,
    // which is the resolution `updated_at` is kept at.
    await Bun.sleep(5);
    await connect(id, "subscription", "token-two");
    const replaced = await setupOf(id);
    expect(step(replaced, "test")?.done).toBe(false);
    expect(replaced.ready).toBe(false);
  });

  it("counts a real run on the current credential as proof, so a working Workspace is not re-tested", async () => {
    const id = await bareWorkspace();
    const made = await connect(id, "api_key", "sk-ant-key");
    await addRepository(id, "solow");
    const [repo] = await db.select().from(repository).where(eq(repository.workspaceId, id));
    const issue = await seedIssue(db, id);
    const task = await createTaskRecord(ctxFor(db, id), {
      issueId: issue.id,
      title: "Ran once",
      agentProfileId: made.harnessProfileId,
      executorProfileId: made.executorProfileId,
      repositories: [{ repositoryId: repo?.id ?? "" }],
      state: "backlog",
    });
    if (!task.ok) throw new Error("seed failed");
    const [sess] = await db
      .insert(session)
      .values({ workspaceId: id, taskId: task.data.id, state: "closed" })
      .returning();
    await db.insert(sessionUsage).values({
      workspaceId: id,
      sessionId: sess?.id ?? "",
      taskId: task.data.id,
      agentProfileId: made.harnessProfileId,
      messageId: "m1",
      seq: 0,
    });

    expect((await setupOf(id)).ready).toBe(true);
  });

  it("keeps the core loop's kill switch above every step", async () => {
    const id = await bareWorkspace();
    await connect(id, "subscription", "token");
    await addRepository(id, "solow");
    await runSetupTest(ctxFor(db, id), async () => PASSED);
    expect((await setupOf(id)).ready).toBe(true);

    await db
      .update(workspace)
      .set({ enabledFlags: { "ff-core-program": false } })
      .where(eq(workspace.id, id));

    const off = await setupOf(id);
    expect(off.coreLoop).toBe(false);
    expect(off.ready).toBe(false);
  });

  it("goes back to unready when something it counted is deleted", async () => {
    // Derived, not remembered: the Executor goes, and so does "connected".
    const id = await bareWorkspace();
    await connect(id, "subscription", "token");
    await addRepository(id, "solow");
    await runSetupTest(ctxFor(db, id), async () => PASSED);
    expect((await setupOf(id)).ready).toBe(true);

    await db.delete(executorProfile).where(eq(executorProfile.workspaceId, id));

    const after = await setupOf(id);
    expect(after.ready).toBe(false);
    expect(step(after, "claude")?.done).toBe(false);
  });

  it("counts only the caller's own rows", async () => {
    const mine = await bareWorkspace("Mine");
    const theirs = await bareWorkspace("Theirs");
    await connect(theirs, "subscription", "not-mine");
    await addRepository(theirs, "not-mine");

    const data = await setupOf(mine);

    expect(data.steps.every((s) => !s.done)).toBe(true);
    expect(data.agent).toBeNull();
  });
});

describe("runSetupTest", () => {
  it("prompts the agent a new Task would use, asking for a real turn", async () => {
    const id = await bareWorkspace();
    const made = await connect(id, "subscription", "token");
    const asked: unknown[] = [];

    const result = await runSetupTest(ctxFor(db, id), async (input) => {
      asked.push(input);
      return PASSED;
    });

    expect(asked).toEqual([{ workspaceId: id, agentProfileId: made.harnessProfileId, turn: true }]);
    expect(result).toEqual({
      ok: true,
      problem: null,
      fixStep: null,
      harness: "Claude Code",
      answered: true,
    });
  });

  it("says there is nothing to test yet without asking anyone", async () => {
    const id = await bareWorkspace();
    let asked = false;

    const result = await runSetupTest(ctxFor(db, id), async () => {
      asked = true;
      return PASSED;
    });

    expect(asked).toBe(false);
    expect(result.problem).toBe("not-connected");
    expect(result.fixStep).toBe("claude");
  });

  it("says the orchestrator did not answer, rather than throwing", async () => {
    const id = await bareWorkspace();
    await connect(id, "subscription", "token");

    const result = await runSetupTest(ctxFor(db, id), async () => {
      throw new Error("orchestrator not configured");
    });

    expect(result).toMatchObject({ ok: false, problem: "unreachable", fixStep: null });
  });

  it("names the cause and the step that fixes it, never the harness's own words", async () => {
    const id = await bareWorkspace();
    await connect(id, "subscription", "token");
    const ctx = ctxFor(db, id);

    expect(await runSetupTest(ctx, async () => failedWith("credential"))).toMatchObject({
      problem: "credential",
      fixStep: "claude",
    });
    // Fixed on the host or by waiting — no step in the flow helps, so none is pointed at.
    expect(await runSetupTest(ctx, async () => failedWith("missing"))).toMatchObject({
      problem: "not-installed",
      fixStep: null,
    });
    expect(await runSetupTest(ctx, async () => failedWith("quota"))).toMatchObject({
      problem: "quota",
      fixStep: null,
    });
    const unclassified = await runSetupTest(ctx, async () => failedWith(undefined));
    expect(unclassified).toMatchObject({ problem: "harness", fixStep: null });
    expect(JSON.stringify(unclassified)).not.toContain("own words");

    // And none of them counts as tested.
    expect(step(await setupOf(id), "test")?.done).toBe(false);
  });
});
