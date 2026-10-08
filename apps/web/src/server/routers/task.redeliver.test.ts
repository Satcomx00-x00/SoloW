/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TaskErrorCode } from "@solow/contracts";
import { DELIVERY_FAILED_REASON } from "@solow/core";
import { task as taskTable } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { seedIssue, seedWorkspaceGraph } from "../dal/test-fixtures.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The two ways out of an approval that committed and could not ship (A1). It used to say "approve
 * again", which nothing could do: the Task was `failed` and only `review` takes a decision, so
 * the one control left was Retry — a whole harness round over work already approved.
 */

process.env["SOLOW_DEV_OWNER"] = "on";

const caller = (db: TestDb, workspaceId: string) =>
  appRouter.createCaller({
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  } satisfies BaseContext);

function wireOrchestrator(status = 202) {
  const posted: Array<{ name: string; data: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    if (String(input).endsWith("/events") && init?.body) posted.push(JSON.parse(init.body));
    return new Response(null, { status });
  }) as typeof globalThis.fetch;
  process.env["SOLOW_ORCHESTRATOR_URL"] = "http://orchestrator.test";
  return {
    posted,
    restore() {
      globalThis.fetch = realFetch;
      Reflect.deleteProperty(process.env, "SOLOW_ORCHESTRATOR_URL");
    },
  };
}

async function failedTask(db: TestDb, failureReason: string) {
  const fx = await seedWorkspaceGraph(db, `redeliver-${failureReason}`);
  const issue = await seedIssue(db, fx.workspaceId);
  const [row] = await db
    .insert(taskTable)
    .values({
      workspaceId: fx.workspaceId,
      issueId: issue.id,
      title: "Ship it",
      state: "failed",
      failureReason,
      agentProfileId: fx.agentProfileId,
      executorProfileId: fx.executorProfileId,
    })
    .returning();
  if (!row) throw new Error("failed to seed task");
  return { workspaceId: fx.workspaceId, taskId: row.id };
}

const rowOf = async (db: TestDb, taskId: string) =>
  (await db.select().from(taskTable).where(eq(taskTable.id, taskId)))[0];

describe("task.redeliver", () => {
  let db: TestDb;
  let wired: ReturnType<typeof wireOrchestrator> | null = null;

  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => {
    wired?.restore();
    wired = null;
  });

  it("asks the orchestrator to ship the committed branch, and runs nothing", async () => {
    wired = wireOrchestrator();
    const fx = await failedTask(db, DELIVERY_FAILED_REASON);

    await caller(db, fx.workspaceId).task.redeliver({ id: fx.taskId });

    expect(wired.posted).toEqual([
      {
        name: "task.redeliver.requested",
        data: { workspaceId: fx.workspaceId, taskId: fx.taskId },
      },
    ]);
    // The orchestrator moves it once the push lands; nothing is claimed before then.
    expect((await rowOf(db, fx.taskId))?.state).toBe("failed");
  });

  it("refuses a Task that failed for another reason — that is what Retry is for", async () => {
    wired = wireOrchestrator();
    const fx = await failedTask(db, "fail");

    await expect(caller(db, fx.workspaceId).task.redeliver({ id: fx.taskId })).rejects.toThrow(
      TaskErrorCode.NotUndelivered,
    );
    expect(wired.posted).toEqual([]);
  });

  it("says so when no orchestrator is running", async () => {
    const fx = await failedTask(db, DELIVERY_FAILED_REASON);

    await expect(caller(db, fx.workspaceId).task.redeliver({ id: fx.taskId })).rejects.toThrow(
      TaskErrorCode.NoOrchestrator,
    );
  });
});

describe("task.keepLocal", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("finishes the Task with the local commit as its result", async () => {
    const fx = await failedTask(db, DELIVERY_FAILED_REASON);

    const out = await caller(db, fx.workspaceId).task.keepLocal({ id: fx.taskId });

    expect(out.state).toBe("done");
    expect(out.failureReason).toBeNull();
  });

  it("refuses a Task that is not waiting to ship", async () => {
    const fx = await failedTask(db, "fail");

    await expect(caller(db, fx.workspaceId).task.keepLocal({ id: fx.taskId })).rejects.toThrow(
      TaskErrorCode.NotUndelivered,
    );
    expect((await rowOf(db, fx.taskId))?.state).toBe("failed");
  });
});
