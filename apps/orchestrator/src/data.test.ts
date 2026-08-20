import { beforeAll, describe, expect, it } from "bun:test";
import {
  agentCatalog,
  agentProfile,
  encryptSecret,
  executorProfile,
  integration,
  issue,
  repository,
  secret,
  session,
  task,
  workspace,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { and, eq } from "drizzle-orm";
import {
  listSessionUsage,
  loadTaskRunContext,
  nextSessionUsageSeq,
  recordSessionUsage,
  setTaskState,
} from "./data.js";

// The secret store reads GATECONTROL_SECRET_KEY lazily; set it before any encryptSecret call.
beforeAll(() => {
  process.env.GATECONTROL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
});

const WS = "ws-alpha";
const OTHER_WS = "ws-beta";
const SECRET_PLAINTEXT = "sk-ant-oat01-super-secret";

async function seed(db: TestDb) {
  const ciphertext = encryptSecret(SECRET_PLAINTEXT);

  await db.insert(workspace).values([
    { id: WS, name: "Alpha", ownerUserId: "user-1" },
    { id: OTHER_WS, name: "Beta", ownerUserId: "user-2" },
  ]);

  await db.insert(secret).values({
    id: "sec-1",
    workspaceId: WS,
    name: "claude-token",
    kind: "subscription_token",
    ciphertext,
  });

  await db.insert(agentCatalog).values({
    id: "cat-1",
    workspaceId: WS,
    key: "claude_code",
    displayName: "Claude Code",
    protocol: "claude_code_stream_json",
    command: "claude",
    subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  });

  await db.insert(agentProfile).values({
    id: "ap-1",
    workspaceId: WS,
    name: "Default Claude",
    agentCatalogId: "cat-1",
    authMode: "subscription",
    secretId: "sec-1",
  });

  await db.insert(executorProfile).values({
    id: "ex-1",
    workspaceId: WS,
    name: "Local",
    kind: "local",
  });

  await db.insert(repository).values({
    id: "repo-1",
    workspaceId: WS,
    name: "gatecontrol",
    source: "local_path",
    location: "/srv/repos/gatecontrol",
  });

  await db.insert(issue).values({
    id: "iss-1",
    workspaceId: WS,
    title: "Fix the gate",
  });

  await db.insert(task).values({
    id: "task-1",
    workspaceId: WS,
    issueId: "iss-1",
    title: "Implement gate fix",
    state: "ready",
    agentProfileId: "ap-1",
    executorProfileId: "ex-1",
    repositoryId: "repo-1",
    baseRef: "main",
  });

  return { ciphertext };
}

/**
 * Point the seeded Task at a Repository imported from an Integration (issue #15), so the clone
 * credential has something to resolve.
 */
async function seedImportedRepository(db: TestDb, scmCiphertext: string) {
  await db.insert(secret).values({
    id: "sec-scm",
    workspaceId: WS,
    name: "github-pat",
    kind: "scm_pat",
    ciphertext: scmCiphertext,
  });
  await db.insert(integration).values({
    id: "int-1",
    workspaceId: WS,
    provider: "github",
    secretId: "sec-scm",
  });
  await db.insert(repository).values({
    id: "repo-imported",
    workspaceId: WS,
    name: "gate",
    source: "remote_url",
    location: "https://github.com/acme/gate.git",
    integrationId: "int-1",
    externalFullName: "acme/gate",
  });
  await db.update(task).set({ repositoryId: "repo-imported" }).where(eq(task.id, "task-1"));
}

describe("loadTaskRunContext — clone credential for an imported Repository", () => {
  it("resolves the Integration's provider and still-encrypted token", async () => {
    const db = createTestDb();
    await seed(db);
    const scmCiphertext = encryptSecret("ghp-clone-me");
    await seedImportedRepository(db, scmCiphertext);

    const ctx = await loadTaskRunContext(db, WS, "task-1");

    expect(ctx.scmClone).toEqual({ provider: "github", secretCiphertext: scmCiphertext });
    // Encrypted here, decrypted only at the point the clone runs (Principle IV).
    expect(JSON.stringify(ctx.scmClone)).not.toContain("ghp-clone-me");
  });

  it("is null for a local path — nothing to authenticate against", async () => {
    const db = createTestDb();
    await seed(db);

    const ctx = await loadTaskRunContext(db, WS, "task-1");
    expect(ctx.scmClone).toBeNull();
  });

  it("is null once the Integration has been disconnected", async () => {
    const db = createTestDb();
    await seed(db);
    await seedImportedRepository(db, encryptSecret("ghp-clone-me"));
    // `integration.delete` unlinks the Repository; the row keeps its remote location and simply
    // has no token any more, which must read as "clone unauthenticated", not as a crash.
    await db
      .update(repository)
      .set({ integrationId: null })
      .where(eq(repository.id, "repo-imported"));

    const ctx = await loadTaskRunContext(db, WS, "task-1");
    expect(ctx.scmClone).toBeNull();
  });
});

describe("loadTaskRunContext", () => {
  it("returns the task, agent profile, repository and the secret ciphertext", async () => {
    const db = createTestDb();
    const { ciphertext } = await seed(db);

    const ctx = await loadTaskRunContext(db, WS, "task-1");

    expect(ctx.task.id).toBe("task-1");
    expect(ctx.task.title).toBe("Implement gate fix");
    expect(ctx.task.state).toBe("ready");

    expect(ctx.agentProfile.id).toBe("ap-1");
    expect(ctx.agentProfile.authMode).toBe("subscription");
    expect(ctx.agentProfile.secretId).toBe("sec-1");

    expect(ctx.agentCatalog.id).toBe("cat-1");
    expect(ctx.agentCatalog.command).toBe("claude");
    expect(ctx.agentCatalog.subscriptionEnvVar).toBe("CLAUDE_CODE_OAUTH_TOKEN");

    expect(ctx.repository.id).toBe("repo-1");
    expect(ctx.repository.source).toBe("local_path");
    expect(ctx.repository.location).toBe("/srv/repos/gatecontrol");

    // The stored value is ciphertext, never plaintext (Principle IV).
    expect(ctx.secretCiphertext).toBe(ciphertext);
    expect(ctx.secretCiphertext).not.toBe(SECRET_PLAINTEXT);
    expect(ctx.secretCiphertext).not.toContain(SECRET_PLAINTEXT);
  });

  it("yields null ciphertext when the agent profile's secret is absent", async () => {
    const db = createTestDb();
    await seed(db);
    // Point the profile at a non-existent secret id.
    await db
      .update(agentProfile)
      .set({ secretId: "sec-missing" })
      .where(eq(agentProfile.id, "ap-1"));

    const ctx = await loadTaskRunContext(db, WS, "task-1");
    expect(ctx.secretCiphertext).toBeNull();
  });

  it("throws for an unknown task id", async () => {
    const db = createTestDb();
    await seed(db);
    await expect(loadTaskRunContext(db, WS, "does-not-exist")).rejects.toThrow(/not found/);
  });

  it("enforces cross-workspace isolation (Principle V)", async () => {
    const db = createTestDb();
    await seed(db);
    // task-1 lives in WS; loading it under OTHER_WS must fail as if it does not exist.
    await expect(loadTaskRunContext(db, OTHER_WS, "task-1")).rejects.toThrow(
      /task task-1 not found in workspace ws-beta/,
    );
  });
});

describe("setTaskState", () => {
  it("updates state and optional result branch on the scoped row", async () => {
    const db = createTestDb();
    await seed(db);

    await setTaskState(db, WS, "task-1", "running");
    let [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.state).toBe("running");

    await setTaskState(db, WS, "task-1", "done", { resultBranch: "gatecontrol/task-task-1" });
    [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.state).toBe("done");
    expect(row?.resultBranch).toBe("gatecontrol/task-task-1");
  });

  it("records a failure reason and can clear it back to null", async () => {
    const db = createTestDb();
    await seed(db);

    await setTaskState(db, WS, "task-1", "failed", { failureReason: "boom" });
    let [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.state).toBe("failed");
    expect(row?.failureReason).toBe("boom");

    await setTaskState(db, WS, "task-1", "ready", { failureReason: null });
    [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.failureReason).toBeNull();
  });

  it("does not touch a row belonging to a different workspace", async () => {
    const db = createTestDb();
    await seed(db);

    // Scope the update to OTHER_WS — the task is in WS, so nothing should change.
    await setTaskState(db, OTHER_WS, "task-1", "done");
    const [row] = await db
      .select()
      .from(task)
      .where(and(eq(task.workspaceId, WS), eq(task.id, "task-1")));
    expect(row?.state).toBe("ready");
  });
});

describe("recordSessionUsage (issue #14)", () => {
  async function seedSession(db: TestDb) {
    await seed(db);
    await db.insert(session).values({ id: "sess-1", workspaceId: WS, taskId: "task-1" });
  }

  const turn = (over: Partial<Parameters<typeof recordSessionUsage>[2]> = {}) => ({
    sessionId: "sess-1",
    taskId: "task-1",
    agentProfileId: "ap-1",
    // Identity follows the turn, so distinct turns need distinct ids by default.
    messageId: `msg-${over.seq ?? 0}`,
    seq: 0,
    model: "claude-sonnet-4-20250514",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 1,
    reported: true,
    ...over,
  });

  it("records a turn's counts and model", async () => {
    const db = createTestDb();
    await seedSession(db);

    await recordSessionUsage(db, WS, turn());

    const rows = await listSessionUsage(db, WS, "sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      reported: true,
      agentProfileId: "ap-1",
    });
  });

  it("is idempotent per turn, so a replay or a repeated block never double-counts", async () => {
    const db = createTestDb();
    await seedSession(db);

    // Principle III: the same step re-runs after an orchestrator restart. And the CLI
    // repeats one turn's usage on every content block, arriving with a different seq.
    await recordSessionUsage(db, WS, turn());
    await recordSessionUsage(db, WS, turn());
    await recordSessionUsage(db, WS, turn({ seq: 7, messageId: "msg-0" }));

    const rows = await listSessionUsage(db, WS, "sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(100);
  });

  it("records an unreported turn rather than omitting it, so coverage gaps stay visible", async () => {
    const db = createTestDb();
    await seedSession(db);

    await recordSessionUsage(
      db,
      WS,
      turn({ seq: 0, reported: false, model: null, inputTokens: 0, outputTokens: 0 }),
    );

    const rows = await listSessionUsage(db, WS, "sess-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reported).toBe(false);
  });

  it("orders turns by seq", async () => {
    const db = createTestDb();
    await seedSession(db);

    await recordSessionUsage(db, WS, turn({ seq: 1, inputTokens: 2 }));
    await recordSessionUsage(db, WS, turn({ seq: 0, inputTokens: 1 }));

    const rows = await listSessionUsage(db, WS, "sess-1");
    expect(rows.map((r) => r.inputTokens)).toEqual([1, 2]);
  });

  it("does not return another Workspace's usage (Principle V)", async () => {
    const db = createTestDb();
    await seedSession(db);
    await recordSessionUsage(db, WS, turn());

    expect(await listSessionUsage(db, OTHER_WS, "sess-1")).toHaveLength(0);
  });
});

describe("nextSessionUsageSeq — turn numbering survives a review round (issue #14)", () => {
  async function seedSession(db: TestDb) {
    await seed(db);
    await db.insert(session).values({ id: "sess-1", workspaceId: WS, taskId: "task-1" });
  }

  const turn = (seq: number, inputTokens: number) => ({
    sessionId: "sess-1",
    taskId: "task-1",
    agentProfileId: "ap-1",
    messageId: `msg-${seq}`,
    seq,
    model: "claude-sonnet-4-20250514",
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reported: true,
  });

  it("starts at 0 for a fresh Session", async () => {
    const db = createTestDb();
    await seedSession(db);
    expect(await nextSessionUsageSeq(db, WS, "sess-1")).toBe(0);
  });

  it("continues after the previous round rather than colliding with it", async () => {
    const db = createTestDb();
    await seedSession(db);

    // Round 0: two turns, numbered from a fresh session.
    let seq = await nextSessionUsageSeq(db, WS, "sess-1");
    await recordSessionUsage(db, WS, turn(seq++, 10));
    await recordSessionUsage(db, WS, turn(seq++, 20));

    // Round 1 — a reviewer asked for changes. The durable step re-enters with a fresh
    // closure; numbering must resume from the database, not restart at 0. A counter that
    // restarted here would collide on the unique index and onConflictDoNothing would
    // discard this round's usage in silence.
    seq = await nextSessionUsageSeq(db, WS, "sess-1");
    expect(seq).toBe(2);
    await recordSessionUsage(db, WS, turn(seq++, 30));

    const rows = await listSessionUsage(db, WS, "sess-1");
    expect(rows.map((r) => r.inputTokens)).toEqual([10, 20, 30]);
  });

  it("counts each Session separately", async () => {
    const db = createTestDb();
    await seedSession(db);
    await db.insert(session).values({ id: "sess-2", workspaceId: WS, taskId: "task-1" });

    await recordSessionUsage(db, WS, turn(0, 10));
    expect(await nextSessionUsageSeq(db, WS, "sess-2")).toBe(0);
  });
});
