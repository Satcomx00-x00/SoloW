import { beforeAll, describe, expect, it } from "bun:test";
import {
  agentProfile,
  encryptSecret,
  executorProfile,
  issue,
  repository,
  secret,
  task,
  workspace,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { and, eq } from "drizzle-orm";
import { loadTaskRunContext, setTaskState } from "./data.js";

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

  await db.insert(agentProfile).values({
    id: "ap-1",
    workspaceId: WS,
    name: "Default Claude",
    agentKind: "claude_code",
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
