/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { CREDENTIAL_EXPIRED_REASON } from "@solow/core";
import { ensureDefaultAgentCatalog, issue as issueTable, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { updateTaskState } from "../dal/task.js";
import { resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * `secret.set` as the recovery path off a credential-expiry pause (spec AC-013, issue #63).
 *
 * There is no separate "renew" endpoint — renewing a credential is setting the same Secret
 * again — so this is the end-to-end proof that a replace resumes exactly the Tasks it should,
 * against a real (in-memory) database and the real router, not a mocked one.
 */

async function seedWs(db: TestDb, name: string): Promise<string> {
  const [row] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!row) throw new Error("failed to seed workspace");
  return row.id;
}

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

function caller(db: TestDb, workspaceId: string) {
  return appRouter.createCaller(ctx(db, workspaceId));
}

/** A Task whose Agent Profile spends a named Secret, created entirely through the router. */
async function taskOnCredential(db: TestDb, wsId: string, secretName: string) {
  const c = caller(db, wsId);
  const agentCatalogId = await ensureDefaultAgentCatalog(db, wsId);
  const { secret } = await c.secret.set({ name: secretName, kind: "api_key", value: "v1" });
  const agent = await c.profile.agent.create({
    name: "Claude",
    agentCatalogId,
    authMode: "api_key",
    secretId: secret.id,
    concurrencyCap: 3,
  });
  const executor = await c.profile.executor.create({ name: "Local" });
  const repo = await c.repository.connect({
    name: "repo",
    source: "local_path",
    location: "/srv/repo",
  });
  const [issue] = await db
    .insert(issueTable)
    .values({ workspaceId: wsId, title: "Fix latch" })
    .returning();
  if (!issue) throw new Error("failed to seed issue");
  const task = await c.task.create({
    issueId: issue.id,
    title: "Stuck on a credential",
    agentProfileId: agent.id,
    executorProfileId: executor.id,
    repositories: [{ repositoryId: repo.id }],
  });
  return { c, secretId: secret.id, taskId: task.id };
}

describe("secret.set — resuming Tasks after a credential is replaced", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 6).toString("base64");
    process.env.SOLOW_STREAM_SECRET ??= "test-stream-secret";
    process.env.SOLOW_AUTH_SECRET ??= "test-auth-secret";
    // Without an orchestrator wired, `enqueueTaskRun` throws unless dev-owner mode is on — and a
    // resume that throws is exactly what the router's per-Task try/catch swallows, so the count
    // this whole file asserts on would silently read 0 without this (task.dependency.test.ts /
    // workflow.test.ts hit the same thing).
    process.env.SOLOW_DEV_OWNER ??= "on";
  });

  beforeEach(() => {
    db = createTestDb();
    resetRateLimits();
  });

  it("resumes a Task paused on this credential, and clears its failure reason (AC-1, AC-3)", async () => {
    const wsId = await seedWs(db, "acme");
    const { c, taskId } = await taskOnCredential(db, wsId, "anthropic-api-key");
    await updateTaskState({ db, workspaceId: wsId, userId: "user-1" }, taskId, "failed", {
      failureReason: CREDENTIAL_EXPIRED_REASON,
    });

    const result = await c.secret.set({ name: "anthropic-api-key", kind: "api_key", value: "v2" });

    expect(result.resumedTaskCount).toBe(1);
    const resumed = await c.task.get({ id: taskId });
    expect(resumed.state).toBe("running");
    expect(resumed.failureReason).toBeNull();
  });

  it("leaves an unrelated Task's failure alone (AC-5 — never guesses which credential)", async () => {
    const wsId = await seedWs(db, "acme");
    const { taskId: unrelatedTaskId } = await taskOnCredential(db, wsId, "other-credential");
    await updateTaskState({ db, workspaceId: wsId, userId: "user-1" }, unrelatedTaskId, "failed", {
      failureReason: CREDENTIAL_EXPIRED_REASON,
    });
    const c = caller(db, wsId);

    const result = await c.secret.set({
      name: "brand-new-credential",
      kind: "api_key",
      value: "v1",
    });

    expect(result.resumedTaskCount).toBe(0);
    const untouched = await c.task.get({ id: unrelatedTaskId });
    expect(untouched.state).toBe("failed");
  });

  it("does not resume a Task that failed for a reason other than its credential", async () => {
    const wsId = await seedWs(db, "acme");
    const { taskId } = await taskOnCredential(db, wsId, "anthropic-api-key");
    await updateTaskState({ db, workspaceId: wsId, userId: "user-1" }, taskId, "failed", {
      failureReason: "fail",
    });
    const c = caller(db, wsId);

    const result = await c.secret.set({ name: "anthropic-api-key", kind: "api_key", value: "v2" });

    expect(result.resumedTaskCount).toBe(0);
    const stillFailed = await c.task.get({ id: taskId });
    expect(stillFailed.state).toBe("failed");
  });

  it("resumes several Tasks paused on the same credential in one write", async () => {
    const wsId = await seedWs(db, "acme");
    const {
      c,
      taskId: firstTaskId,
      secretId,
    } = await taskOnCredential(db, wsId, "shared-credential");
    await updateTaskState({ db, workspaceId: wsId, userId: "user-1" }, firstTaskId, "failed", {
      failureReason: CREDENTIAL_EXPIRED_REASON,
    });
    // A second Task under the same Agent Profile, so it spends the same Secret.
    const agents = await c.profile.agent.list({});
    const agent = agents.items.find((a) => a.secretId === secretId);
    if (!agent) throw new Error("seed failed");
    const executors = (await c.profile.executor.list({})).items;
    const repos = (await c.repository.list({})).items;
    const [issue] = await db
      .insert(issueTable)
      .values({ workspaceId: wsId, title: "Also stuck" })
      .returning();
    if (!issue || !executors[0] || !repos[0]) throw new Error("seed failed");
    const secondTask = await c.task.create({
      issueId: issue.id,
      title: "Also stuck",
      agentProfileId: agent.id,
      executorProfileId: executors[0].id,
      repositories: [{ repositoryId: repos[0].id }],
    });
    await updateTaskState({ db, workspaceId: wsId, userId: "user-1" }, secondTask.id, "failed", {
      failureReason: CREDENTIAL_EXPIRED_REASON,
    });

    const result = await c.secret.set({ name: "shared-credential", kind: "api_key", value: "v2" });

    expect(result.resumedTaskCount).toBe(2);
  });

  it("does not report a resume for a brand-new Secret nothing could have failed on yet", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);

    const result = await c.secret.set({ name: "first-time", kind: "api_key", value: "v1" });

    expect(result.resumedTaskCount).toBe(0);
  });

  it("never puts the credential's value in the response, on either the create or the replace path (Principle IV)", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    const created = await c.secret.set({
      name: "checked-credential",
      kind: "api_key",
      value: "sk-ant-should-never-appear",
    });
    expect(JSON.stringify(created)).not.toContain("sk-ant-should-never-appear");

    const replaced = await c.secret.set({
      name: "checked-credential",
      kind: "api_key",
      value: "sk-ant-should-also-never-appear",
    });
    expect(JSON.stringify(replaced)).not.toContain("sk-ant-should-also-never-appear");
  });
});
