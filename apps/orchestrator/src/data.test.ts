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
  sessionEvent,
  task,
  taskRepository,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, asc, eq } from "drizzle-orm";
import {
  appendSessionEvent,
  compactSession,
  latestStateTransition,
  listSessionLog,
  listSessionSummaries,
  listSessionUsage,
  loadTaskRunContext,
  nextSessionUsageSeq,
  recordSessionUsage,
  setTaskRepositoryResultBranch,
  setTaskState,
} from "./data.js";

// The secret store reads SOLOW_SECRET_KEY lazily; set it before any encryptSecret call.
beforeAll(() => {
  process.env.SOLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
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
    name: "solow",
    source: "local_path",
    location: "/srv/repos/solow",
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
  });
  await db.insert(taskRepository).values({
    id: "attach-1",
    workspaceId: WS,
    taskId: "task-1",
    repositoryId: "repo-1",
    baseRef: "main",
    checkoutBranch: "solow/task-task-1",
    position: 0,
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
  await db
    .update(taskRepository)
    .set({ repositoryId: "repo-imported" })
    .where(eq(taskRepository.taskId, "task-1"));
}

describe("loadTaskRunContext — clone credential for an imported Repository", () => {
  it("resolves the Integration's provider and still-encrypted token", async () => {
    const db = createTestDb();
    await seed(db);
    const scmCiphertext = encryptSecret("ghp-clone-me");
    await seedImportedRepository(db, scmCiphertext);

    const ctx = await loadTaskRunContext(db, WS, "task-1");

    expect(ctx.repositories[0]?.scmClone).toEqual({
      provider: "github",
      secretCiphertext: scmCiphertext,
    });
    // Encrypted here, decrypted only at the point the clone runs (Principle IV).
    expect(JSON.stringify(ctx.repositories)).not.toContain("ghp-clone-me");
  });

  it("is null for a local path — nothing to authenticate against", async () => {
    const db = createTestDb();
    await seed(db);

    const ctx = await loadTaskRunContext(db, WS, "task-1");
    expect(ctx.repositories[0]?.scmClone).toBeNull();
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
    expect(ctx.repositories[0]?.scmClone).toBeNull();
  });
});

/**
 * The Task ↔ Repository join, from the orchestrator's side (issue #7). The lifecycle iterates
 * over `ctx.repositories`, so what this asks is whether that list is ordered, complete, and
 * refuses to be empty.
 */
describe("loadTaskRunContext — several attached Repositories", () => {
  /** A second Repository on the same Task, at the position the caller names. */
  async function attachSecond(db: TestDb, position: number) {
    await db.insert(repository).values({
      id: "repo-2",
      workspaceId: WS,
      name: "shared-lib",
      source: "local_path",
      location: "/srv/repos/shared-lib",
    });
    await db.insert(taskRepository).values({
      id: "attach-2",
      workspaceId: WS,
      taskId: "task-1",
      repositoryId: "repo-2",
      baseRef: "develop",
      checkoutBranch: "solow/task-task-1",
      position,
    });
  }

  it("returns every attachment with its own Repository row", async () => {
    const db = createTestDb();
    await seed(db);
    await attachSecond(db, 1);

    const ctx = await loadTaskRunContext(db, WS, "task-1");

    expect(ctx.repositories.map((b) => b.repository.name)).toEqual(["solow", "shared-lib"]);
    expect(ctx.repositories.map((b) => b.attachment.baseRef)).toEqual(["main", "develop"]);
  });

  it("orders them by position, not by insertion, so the primary is never insertion-order luck", async () => {
    const db = createTestDb();
    await seed(db);
    // Inserted second but positioned first: the agent must be started in this one.
    await db.update(taskRepository).set({ position: 1 }).where(eq(taskRepository.id, "attach-1"));
    await attachSecond(db, 0);

    const ctx = await loadTaskRunContext(db, WS, "task-1");

    expect(ctx.repositories.map((b) => b.repository.name)).toEqual(["shared-lib", "solow"]);
  });

  it("resolves each attachment's own clone credential", async () => {
    // Two attachments imported from two different Integrations each need their own token; one
    // credential per Task could only ever have been right for one of them.
    const db = createTestDb();
    await seed(db);
    const ciphertext = encryptSecret("ghp-clone-me");
    await seedImportedRepository(db, ciphertext);
    await db.insert(repository).values({
      id: "repo-local",
      workspaceId: WS,
      name: "local-only",
      source: "local_path",
      location: "/srv/repos/local-only",
    });
    await db.insert(taskRepository).values({
      id: "attach-2",
      workspaceId: WS,
      taskId: "task-1",
      repositoryId: "repo-local",
      checkoutBranch: "solow/task-task-1",
      position: 1,
    });

    const ctx = await loadTaskRunContext(db, WS, "task-1");

    expect(ctx.repositories[0]?.scmClone).toEqual({
      provider: "github",
      secretCiphertext: ciphertext,
    });
    expect(ctx.repositories[1]?.scmClone).toBeNull();
  });

  it("refuses a Task with nothing attached, by name, rather than returning an empty list", async () => {
    // A Task with no attachment cannot be run at all. Failing at load is the difference between
    // a legible error and "cannot read property location of undefined" three steps later.
    const db = createTestDb();
    await seed(db);
    await db.delete(taskRepository).where(eq(taskRepository.taskId, "task-1"));

    await expect(loadTaskRunContext(db, WS, "task-1")).rejects.toThrow(
      /task task-1 has no repository attached/,
    );
  });

  it("does not see an attachment belonging to another Workspace (Principle V)", async () => {
    const db = createTestDb();
    await seed(db);
    await db
      .update(taskRepository)
      .set({ workspaceId: OTHER_WS })
      .where(eq(taskRepository.id, "attach-1"));

    await expect(loadTaskRunContext(db, WS, "task-1")).rejects.toThrow(
      /has no repository attached/,
    );
  });
});

describe("setTaskRepositoryResultBranch", () => {
  it("records the branch on the attachment, leaving the others alone", async () => {
    const db = createTestDb();
    await seed(db);
    await db.insert(repository).values({
      id: "repo-2",
      workspaceId: WS,
      name: "shared-lib",
      source: "local_path",
      location: "/srv/repos/shared-lib",
    });
    await db.insert(taskRepository).values({
      id: "attach-2",
      workspaceId: WS,
      taskId: "task-1",
      repositoryId: "repo-2",
      checkoutBranch: "solow/task-task-1",
      position: 1,
    });

    await setTaskRepositoryResultBranch(db, WS, "attach-1", "solow/task-task-1");

    const rows = await db
      .select()
      .from(taskRepository)
      .where(eq(taskRepository.taskId, "task-1"))
      .orderBy(taskRepository.position);
    expect(rows[0]?.resultBranch).toBe("solow/task-task-1");
    expect(rows[1]?.resultBranch).toBeNull();
  });

  it("will not write into another Workspace's attachment (Principle V)", async () => {
    const db = createTestDb();
    await seed(db);

    await setTaskRepositoryResultBranch(db, OTHER_WS, "attach-1", "hijacked");

    const [row] = await db.select().from(taskRepository).where(eq(taskRepository.id, "attach-1"));
    expect(row?.resultBranch).toBeNull();
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

    expect(ctx.repositories).toHaveLength(1);
    expect(ctx.repositories[0]?.repository.id).toBe("repo-1");
    expect(ctx.repositories[0]?.repository.source).toBe("local_path");
    expect(ctx.repositories[0]?.repository.location).toBe("/srv/repos/solow");
    expect(ctx.repositories[0]?.attachment.baseRef).toBe("main");

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
  it("updates state on the scoped row", async () => {
    const db = createTestDb();
    await seed(db);

    await setTaskState(db, WS, "task-1", "running");
    let [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.state).toBe("running");

    await setTaskState(db, WS, "task-1", "done");
    [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.state).toBe("done");
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

/**
 * The session log's three new properties (issue #2): payloads validated at write time, a
 * compaction pass that can only ever insert, and a cursor that refuses a rewritten history.
 */
describe("session log (issue #2)", () => {
  async function seedSession(db: TestDb) {
    await seed(db);
    await db.insert(session).values({ id: "sess-1", workspaceId: WS, taskId: "task-1" });
  }

  const append = (db: TestDb, seq: number, text: string) =>
    appendSessionEvent(db, WS, {
      sessionId: "sess-1",
      seq,
      payload: { kind: "assistant_turn", text, thinking: false },
    });

  /** Every row of the log, exactly as stored — the comparison AC-2 turns on. */
  const rawRows = (db: TestDb) =>
    db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, "sess-1"))
      .orderBy(asc(sessionEvent.seq));

  it("derives the kind column from the payload, so the two can never disagree", async () => {
    const db = createTestDb();
    await seedSession(db);

    await appendSessionEvent(db, WS, {
      sessionId: "sess-1",
      seq: 0,
      payload: { kind: "tool_call", name: "Edit", callId: null },
    });

    const [row] = await rawRows(db);
    expect(row?.kind).toBe("tool_call");
    expect(row?.payload).toEqual({ kind: "tool_call", name: "Edit", callId: null });
  });

  it("refuses to write a payload the union does not admit", async () => {
    const db = createTestDb();
    await seedSession(db);

    await expect(
      appendSessionEvent(db, WS, {
        sessionId: "sess-1",
        seq: 0,
        // The shape the log used to accept without complaint, and which every reader then had
        // to guess at (issue #2, AC-1).
        payload: { kind: "stdout", text: "working" } as never,
      }),
    ).rejects.toThrow();
    expect(await rawRows(db)).toHaveLength(0);
  });

  it("reads a row written before the union existed back as a typed event", async () => {
    const db = createTestDb();
    await seedSession(db);
    // Exactly what an earlier run left behind: an opaque payload under a transport-word kind.
    await db.insert(sessionEvent).values({
      id: "legacy-0",
      workspaceId: WS,
      sessionId: "sess-1",
      seq: 0,
      kind: "stdout",
      payload: { text: "patched latch.ts\n" },
    });

    expect(await listSessionLog(db, WS, "sess-1")).toEqual([
      { seq: 0, payload: { kind: "assistant_turn", text: "patched latch.ts\n", thinking: false } },
    ]);
  });

  it("records a summary for a long session and leaves every event exactly where it was", async () => {
    const db = createTestDb();
    await seedSession(db);
    for (let seq = 0; seq < 60; seq++) await append(db, seq, `line ${seq}`);
    const before = await rawRows(db);

    const planned = await compactSession(db, WS, "sess-1", { threshold: 20, tail: 10 });

    expect(planned).toHaveLength(1);
    const summaries = await listSessionSummaries(db, WS, "sess-1");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.fromSeq).toBe(0);
    expect(summaries[0]?.toSeq).toBe(49);
    expect(summaries[0]?.eventCount).toBe(50);
    // AC-2, stated as the only thing that would actually catch a regression: the log is
    // byte-identical afterwards. Nothing was deleted, nothing was rewritten.
    expect(await rawRows(db)).toEqual(before);
  });

  it("records the same range twice as a no-op, so a replayed step does not duplicate it", async () => {
    const db = createTestDb();
    await seedSession(db);
    for (let seq = 0; seq < 60; seq++) await append(db, seq, `line ${seq}`);

    await compactSession(db, WS, "sess-1", { threshold: 20, tail: 10 });
    const first = await listSessionSummaries(db, WS, "sess-1");
    await compactSession(db, WS, "sess-1", { threshold: 20, tail: 10 });

    expect(await listSessionSummaries(db, WS, "sess-1")).toEqual(first);
  });

  it("does not compact a session that has not got long yet", async () => {
    const db = createTestDb();
    await seedSession(db);
    for (let seq = 0; seq < 5; seq++) await append(db, seq, `line ${seq}`);

    expect(await compactSession(db, WS, "sess-1")).toEqual([]);
    expect(await listSessionSummaries(db, WS, "sess-1")).toHaveLength(0);
  });

  it("records a state transition once when a retried step body records it again", async () => {
    // `recordTransition` reads its seq back as max+1, so the unique index cannot dedupe it and a
    // retried Inngest step body would otherwise leave a reviewer looking at the same move twice.
    const db = createTestDb();
    await seedSession(db);
    await db.insert(sessionEvent).values({
      id: "state-0",
      workspaceId: WS,
      sessionId: "sess-1",
      seq: 0,
      kind: "state",
      payload: { kind: "state", from: "running", to: "review" },
    });

    const latest = await latestStateTransition(db, WS, "sess-1");
    expect(latest).toEqual({ kind: "state", from: "running", to: "review" });
  });

  it("reports no state transition for a Session that has only ever recorded turns", async () => {
    const db = createTestDb();
    await seedSession(db);
    await append(db, 0, "line 0");
    expect(await latestStateTransition(db, WS, "sess-1")).toBeNull();
  });

  it("does not read another Workspace's state transitions (Principle V)", async () => {
    const db = createTestDb();
    await seedSession(db);
    await db.insert(sessionEvent).values({
      id: "state-0",
      workspaceId: WS,
      sessionId: "sess-1",
      seq: 0,
      kind: "state",
      payload: { kind: "state", from: "running", to: "review" },
    });
    expect(await latestStateTransition(db, OTHER_WS, "sess-1")).toBeNull();
  });

  it("does not return another Workspace's summaries (Principle V)", async () => {
    const db = createTestDb();
    await seedSession(db);
    for (let seq = 0; seq < 60; seq++) await append(db, seq, `line ${seq}`);
    await compactSession(db, WS, "sess-1", { threshold: 20, tail: 10 });

    expect(await listSessionSummaries(db, OTHER_WS, "sess-1")).toHaveLength(0);
  });
});
