/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { TaskErrorCode } from "@solow/contracts";
import {
  ensureDefaultHarnessCatalog,
  executorProfile,
  harnessProfile,
  issue as issueTable,
  secret,
  session as sessionTable,
  task as taskTable,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

// Dev-owner: the enqueue logs instead of needing an orchestrator.
process.env["SOLOW_DEV_OWNER"] = "on";

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

const caller = (db: TestDb, workspaceId: string) => appRouter.createCaller(ctx(db, workspaceId));

/** A Task in `state`, with the Session its last run left. */
async function taskFixture(db: TestDb, state: "ready" | "review") {
  const sessionState = "awaiting_review" as const;
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Acme", ownerUserId: "owner-1" })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");
  const catalogId = await ensureDefaultHarnessCatalog(db, ws.id);
  const [sec] = await db
    .insert(secret)
    .values({ workspaceId: ws.id, name: "token", kind: "subscription_token", ciphertext: "x" })
    .returning();
  const [harness] = await db
    .insert(harnessProfile)
    .values({
      workspaceId: ws.id,
      name: "claude",
      agentCatalogId: catalogId,
      authMode: "subscription",
      secretId: sec?.id ?? "sec",
    })
    .returning();
  const [executor] = await db
    .insert(executorProfile)
    .values({ workspaceId: ws.id, name: "local" })
    .returning();
  const [issue] = await db
    .insert(issueTable)
    .values({ workspaceId: ws.id, title: "Ship it" })
    .returning();
  const [task] = await db
    .insert(taskTable)
    .values({
      workspaceId: ws.id,
      issueId: issue?.id ?? "",
      title: "Add farewell()",
      state,
      agentProfileId: harness?.id ?? "",
      executorProfileId: executor?.id ?? "",
    })
    .returning();
  if (!task) throw new Error("failed to seed task");
  const [session] = await db
    .insert(sessionTable)
    .values({ workspaceId: ws.id, taskId: task.id, state: sessionState })
    .returning();
  if (!session) throw new Error("failed to seed session");
  return { workspaceId: ws.id, taskId: task.id, sessionId: session.id };
}

/**
 * One start, one run.
 *
 * Reading the state and then writing `running` let two clicks both start a run, and a launch from
 * the review gate started a fresh harness beside the decision that gate was waiting for — seen
 * as three runs on one Task, each writing the Step cursor the others read.
 */
describe("starting a Task", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("refuses to start a Task waiting at its review gate", async () => {
    const fx = await taskFixture(db, "review");
    const c = caller(db, fx.workspaceId);

    await expect(c.task.launch({ id: fx.taskId })).rejects.toThrow();
    await expect(c.task.move({ id: fx.taskId, to: "running" })).rejects.toThrow(
      TaskErrorCode.AwaitingReview,
    );

    expect((await c.task.get({ id: fx.taskId })).state).toBe("review");
    const sessions = await db.select().from(sessionTable).where(eq(sessionTable.taskId, fx.taskId));
    expect(sessions).toHaveLength(1);
  });

  it("starts a ready Task exactly once, however many times it is asked", async () => {
    const fx = await taskFixture(db, "ready");
    const c = caller(db, fx.workspaceId);

    const outcomes = await Promise.allSettled([
      c.task.move({ id: fx.taskId, to: "running" }),
      c.task.move({ id: fx.taskId, to: "running" }),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((await c.task.get({ id: fx.taskId })).state).toBe("running");
    // The seeded Session plus exactly one for the run that started.
    const sessions = await db.select().from(sessionTable).where(eq(sessionTable.taskId, fx.taskId));
    expect(sessions).toHaveLength(2);
  });
});
