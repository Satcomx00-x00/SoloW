/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TaskErrorCode, type TaskState } from "@solow/contracts";
import { harnessProfile, session as sessionTable, task as taskTable } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, eq, isNull, sql } from "drizzle-orm";
import { seedIssue, seedWorkspaceGraph } from "../dal/test-fixtures.js";
import { resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The Harness Profile concurrency cap under simultaneous starts (FINDINGS F5).
 *
 * Against a real SQLite database, because the defect was never in the arithmetic — it was the gap
 * between counting the running Tasks and writing the new one. Every start used to read the count,
 * compare it with the cap and then claim its row, with an `await` between each; N requests fired
 * together all read the same count and all passed. The cap is the product's main guard against
 * draining a subscription, and it held only for starts that happened not to overlap.
 */

// Dev-owner: the enqueue logs instead of needing an orchestrator.
process.env["SOLOW_DEV_OWNER"] = "on";

const caller = (db: TestDb, workspaceId: string) =>
  appRouter.createCaller({
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  } satisfies BaseContext);

async function setCap(db: TestDb, profileId: string, cap: number) {
  await db
    .update(harnessProfile)
    .set({ concurrencyCap: cap })
    .where(eq(harnessProfile.id, profileId));
}

async function seedTasks(
  db: TestDb,
  fx: Awaited<ReturnType<typeof seedWorkspaceGraph>>,
  count: number,
  state: TaskState,
  agentProfileId = fx.agentProfileId,
): Promise<string[]> {
  const issue = await seedIssue(db, fx.workspaceId);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const [row] = await db
      .insert(taskTable)
      .values({
        workspaceId: fx.workspaceId,
        issueId: issue.id,
        title: `task ${state} ${i}`,
        state,
        agentProfileId,
        executorProfileId: fx.executorProfileId,
      })
      .returning();
    if (!row) throw new Error("failed to seed task");
    ids.push(row.id);
  }
  return ids;
}

async function runningFor(db: TestDb, profileId: string): Promise<number> {
  const rows = await db
    .select({ id: taskTable.id })
    .from(taskTable)
    .where(
      and(
        eq(taskTable.agentProfileId, profileId),
        eq(taskTable.state, "running"),
        isNull(taskTable.deletedAt),
      ),
    );
  return rows.length;
}

/** Split settled starts into how many ran and why the rest were refused. */
/**
 * A refused start either throws or, for a Quick task, answers `started: false` with the reason:
 * its Issue and Task are already written by then, so the refusal is part of the answer.
 */
function refusalOf(r: PromiseSettledResult<unknown>): string | null {
  if (r.status === "rejected") return (r.reason as Error).message;
  const out = r.value as { started?: boolean; reason?: string | null };
  return out.started === false ? (out.reason ?? "") : null;
}

function tally(results: PromiseSettledResult<unknown>[]) {
  const refusals = results.map(refusalOf).filter((x): x is string => x !== null);
  return { passed: results.length - refusals.length, refusals };
}

describe("concurrency cap under simultaneous starts (F5)", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
    resetRateLimits();
  });

  it("lets exactly K of N simultaneous launches through a cap of K", async () => {
    const fx = await seedWorkspaceGraph(db, "race");
    const cap = 3;
    const attempts = 8;
    await setCap(db, fx.agentProfileId, cap);
    const ids = await seedTasks(db, fx, attempts, "ready");
    const c = caller(db, fx.workspaceId);

    const results = await Promise.allSettled(ids.map((id) => c.task.launch({ id })));

    const { passed, refusals } = tally(results);
    expect(passed).toBe(cap);
    expect(refusals).toEqual(Array(attempts - cap).fill(TaskErrorCode.ConcurrencyCapReached));
    expect(await runningFor(db, fx.agentProfileId)).toBe(cap);
    // A refused start leaves nothing behind: no Session for a run that never began.
    expect(await db.select().from(sessionTable)).toHaveLength(cap);
  });

  it("holds the cap across every start path at once — launch, move, retry, quick task", async () => {
    const fx = await seedWorkspaceGraph(db, "mixed");
    const cap = 2;
    await setCap(db, fx.agentProfileId, cap);
    const ready = await seedTasks(db, fx, 4, "ready");
    const failed = await seedTasks(db, fx, 2, "failed");
    const parked = await seedTasks(db, fx, 2, "parked");
    const c = caller(db, fx.workspaceId);

    const results = await Promise.allSettled([
      c.task.launch({ id: ready[0] ?? "" }),
      c.task.launch({ id: ready[1] ?? "" }),
      c.task.move({ id: ready[2] ?? "", to: "running" }),
      c.task.move({ id: ready[3] ?? "", to: "running" }),
      c.task.retry({ id: failed[0] ?? "" }),
      c.task.retry({ id: failed[1] ?? "" }),
      c.task.retry({ id: parked[0] ?? "" }),
      c.task.move({ id: parked[1] ?? "", to: "running" }),
      c.task.quickStart({ prompt: "one more" }),
      c.task.quickStart({ prompt: "and another" }),
    ]);

    const { passed, refusals } = tally(results);
    expect(passed).toBe(cap);
    expect(new Set(refusals)).toEqual(new Set([TaskErrorCode.ConcurrencyCapReached]));
    expect(await runningFor(db, fx.agentProfileId)).toBe(cap);
  });

  it("counts per Harness Profile: a full Profile does not hold another back", async () => {
    const fx = await seedWorkspaceGraph(db, "per-profile");
    await setCap(db, fx.agentProfileId, 1);
    const [profile] = await db
      .select()
      .from(harnessProfile)
      .where(eq(harnessProfile.id, fx.agentProfileId));
    if (!profile) throw new Error("seed");
    const [other] = await db
      .insert(harnessProfile)
      .values({ ...profile, id: undefined, name: "other", concurrencyCap: 1 })
      .returning();
    if (!other) throw new Error("seed");
    const mine = await seedTasks(db, fx, 3, "ready");
    const theirs = await seedTasks(db, fx, 3, "ready", other.id);
    const c = caller(db, fx.workspaceId);

    const results = await Promise.allSettled(
      [...mine, ...theirs].map((id) => c.task.launch({ id })),
    );

    expect(tally(results).passed).toBe(2);
    expect(await runningFor(db, fx.agentProfileId)).toBe(1);
    expect(await runningFor(db, other.id)).toBe(1);
  });

  it("gives the slot back on every way out of running", async () => {
    const fx = await seedWorkspaceGraph(db, "release");
    await setCap(db, fx.agentProfileId, 1);
    const c = caller(db, fx.workspaceId);

    // Each resting or terminal state the run engine moves a Task to — parked on a quota window,
    // failed, at its review gate, done — frees the slot, and so does the Task going to History.
    const exits: Array<{ state?: TaskState; deletedAt?: string }> = [
      { state: "parked" },
      { state: "failed" },
      { state: "review" },
      { state: "done" },
      { deletedAt: new Date().toISOString() },
    ];
    for (const exit of exits) {
      const [holder, waiting] = await seedTasks(db, fx, 2, "ready");
      if (!holder || !waiting) throw new Error("seed");
      await c.task.launch({ id: holder });
      await expect(c.task.launch({ id: waiting })).rejects.toThrow(
        TaskErrorCode.ConcurrencyCapReached,
      );

      await db.update(taskTable).set(exit).where(eq(taskTable.id, holder));
      await c.task.launch({ id: waiting });
      expect(await runningFor(db, fx.agentProfileId)).toBe(1);
      // Out of the way for the next exit.
      await db.update(taskTable).set({ state: "done" }).where(eq(taskTable.id, waiting));
    }
  });

  it("gives the slot back when the Session cannot be opened after the claim", async () => {
    const fx = await seedWorkspaceGraph(db, "no-session");
    await setCap(db, fx.agentProfileId, 1);
    const [first, second] = await seedTasks(db, fx, 2, "ready");
    if (!first || !second) throw new Error("seed");
    const c = caller(db, fx.workspaceId);
    // The claim is its own write, so any failure between it and the enqueue strands a `running`
    // row with no harness behind it unless the rollback covers it.
    db.run(sql`CREATE TRIGGER no_session BEFORE INSERT ON session
      BEGIN SELECT RAISE(ABORT, 'session insert refused'); END`);

    await expect(c.task.launch({ id: first })).rejects.toThrow();

    expect((await db.select().from(taskTable).where(eq(taskTable.id, first)))[0]?.state).toBe(
      "ready",
    );
    expect(await runningFor(db, fx.agentProfileId)).toBe(0);
    db.run(sql`DROP TRIGGER no_session`);
    await c.task.launch({ id: second });
    expect(await runningFor(db, fx.agentProfileId)).toBe(1);
  });
});

/** Wire the API to an orchestrator stubbed at `fetch`, as `review.decide.test.ts` does. */
function wireOrchestrator() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  process.env["SOLOW_ORCHESTRATOR_URL"] = "http://orchestrator.test";
  return () => {
    globalThis.fetch = realFetch;
    Reflect.deleteProperty(process.env, "SOLOW_ORCHESTRATOR_URL");
  };
}

describe("a review decision that sends a harness back to work takes a slot (F5)", () => {
  let db: TestDb;
  let restore: (() => void) | null = null;

  beforeEach(() => {
    db = createTestDb();
    resetRateLimits();
    restore = wireOrchestrator();
  });

  afterEach(() => {
    restore?.();
    restore = null;
  });

  async function gates(fx: Awaited<ReturnType<typeof seedWorkspaceGraph>>, count: number) {
    const ids = await seedTasks(db, fx, count, "review");
    const sessions: string[] = [];
    for (const taskId of ids) {
      const [row] = await db
        .insert(sessionTable)
        .values({ workspaceId: fx.workspaceId, taskId, state: "awaiting_review" })
        .returning();
      if (!row) throw new Error("seed");
      sessions.push(row.id);
    }
    return sessions;
  }

  it("lets exactly K of N simultaneous request-changes and launches through", async () => {
    const fx = await seedWorkspaceGraph(db, "decide");
    const cap = 2;
    await setCap(db, fx.agentProfileId, cap);
    const sessions = await gates(fx, 3);
    const ready = await seedTasks(db, fx, 3, "ready");
    const c = caller(db, fx.workspaceId);

    const results = await Promise.allSettled([
      ...sessions.map((sessionId) =>
        c.review.decide({ sessionId, decision: "request_changes", feedback: "again" }),
      ),
      ...ready.map((id) => c.task.launch({ id })),
    ]);

    const { passed, refusals } = tally(results);
    expect(passed).toBe(cap);
    expect(new Set(refusals)).toEqual(new Set([TaskErrorCode.ConcurrencyCapReached]));
    expect(await runningFor(db, fx.agentProfileId)).toBe(cap);
  });

  it("leaves a refused decision's gate exactly as it was", async () => {
    const fx = await seedWorkspaceGraph(db, "refused");
    await setCap(db, fx.agentProfileId, 1);
    await seedTasks(db, fx, 1, "running");
    const [sessionId] = await gates(fx, 1);
    if (!sessionId) throw new Error("seed");
    const c = caller(db, fx.workspaceId);

    await expect(
      c.review.decide({ sessionId, decision: "request_changes", feedback: "again" }),
    ).rejects.toThrow(TaskErrorCode.ConcurrencyCapReached);

    const [gate] = await db.select().from(sessionTable).where(eq(sessionTable.id, sessionId));
    expect(gate?.state).toBe("awaiting_review");
    const [row] = await db
      .select()
      .from(taskTable)
      .where(eq(taskTable.id, gate?.taskId ?? ""));
    expect(row?.state).toBe("review");
  });

  it("never holds a reject or a plain approval hostage to the cap", async () => {
    // Neither starts a harness: reject discards, approval off a Workflow commits. Refusing them at
    // the cap would keep finished work at its gate for a limit that is about harness spend.
    const fx = await seedWorkspaceGraph(db, "no-harness");
    await setCap(db, fx.agentProfileId, 1);
    await seedTasks(db, fx, 1, "running");
    const [rejected, approved] = await gates(fx, 2);
    const c = caller(db, fx.workspaceId);

    await c.review.decide({ sessionId: rejected ?? "", decision: "reject" });
    await c.review.decide({ sessionId: approved ?? "", decision: "approve" });
  });
});
