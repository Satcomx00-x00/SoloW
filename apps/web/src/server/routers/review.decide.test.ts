/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ReviewErrorCode } from "@solow/contracts";
import { STRANDED_REVIEW_REASON } from "@solow/core";
import {
  ensureDefaultHarnessCatalog,
  executorProfile,
  harnessProfile,
  issue as issueTable,
  review as reviewTable,
  secret,
  session as sessionTable,
  task as taskTable,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The review gate is a row, and a decision is what starts the run that applies it.
 *
 * Before this, the gate was a run parked in the engine's `waitForEvent`, and the local Dev Server
 * lost those on restart: decisions were published to nothing, Approve stayed on screen, and one
 * real Task took twenty Approves in a minute with nothing happening. Now `review.decide` takes
 * the gate in one conditional write and starts the run with the decision in its event — so a
 * decision is either delivered or refused where it was clicked, and a second click on the same
 * gate is refused instead of starting a second run.
 */

// Dev-owner is the mode the local stack runs in.
process.env["SOLOW_DEV_OWNER"] = "on";

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

const caller = (db: TestDb, workspaceId: string) => appRouter.createCaller(ctx(db, workspaceId));

/** A Task at its review gate: the run that opened it has ended, its Session `awaiting_review`. */
async function gateFixture(db: TestDb) {
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
      state: "review",
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

const stateOf = async (db: TestDb, taskId: string) => {
  const c = caller(db, (await db.select().from(taskTable))[0]?.workspaceId ?? "");
  const row = await c.task.get({ id: taskId });
  return { state: row.state, failureReason: row.failureReason };
};

const sessionStateOf = async (db: TestDb, sessionId: string) =>
  (await db.select().from(sessionTable).where(eq(sessionTable.id, sessionId)))[0]?.state;

/** Wire the API to an orchestrator stubbed at `fetch`, recording what was published. */
function wireOrchestrator(status = 200) {
  const posted: Array<{ name: string; data: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    if (String(input).endsWith("/events") && init?.body) posted.push(JSON.parse(init.body));
    return new Response("{}", { status });
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

describe("review.decide", () => {
  let db: TestDb;
  let wired: ReturnType<typeof wireOrchestrator> | null = null;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    wired?.restore();
    wired = null;
  });

  it("takes the gate and starts the run that applies the decision", async () => {
    wired = wireOrchestrator();
    const fx = await gateFixture(db);

    const review = await caller(db, fx.workspaceId).review.decide({
      sessionId: fx.sessionId,
      decision: "approve",
    });

    // Out of the gate at once: the run applying it is what moves it on to `done`.
    expect(await stateOf(db, fx.taskId)).toEqual({ state: "running", failureReason: null });
    expect(await sessionStateOf(db, fx.sessionId)).toBe("active");
    expect(wired.posted).toEqual([
      {
        name: "task.launch.requested",
        data: {
          workspaceId: fx.workspaceId,
          taskId: fx.taskId,
          sessionId: fx.sessionId,
          review: { id: review.id, decision: "approve", feedback: null },
        },
      },
    ]);
  });

  it("carries the reviewer's feedback to the run", async () => {
    wired = wireOrchestrator();
    const fx = await gateFixture(db);

    await caller(db, fx.workspaceId).review.decide({
      sessionId: fx.sessionId,
      decision: "request_changes",
      feedback: "tighten the error handling",
    });

    const review = wired.posted[0]?.data["review"] as { feedback: string };
    expect(review.feedback).toBe("tighten the error handling");
  });

  it("refuses a second decision on the same gate — one click, one run", async () => {
    // Twenty Approves in a minute, from one person who saw nothing happen, is the case.
    wired = wireOrchestrator();
    const fx = await gateFixture(db);
    const c = caller(db, fx.workspaceId);

    await c.review.decide({ sessionId: fx.sessionId, decision: "approve" });
    await expect(c.review.decide({ sessionId: fx.sessionId, decision: "approve" })).rejects.toThrow(
      ReviewErrorCode.NotInReview,
    );

    expect(wired.posted).toHaveLength(1);
    expect(await db.select().from(reviewTable)).toHaveLength(1);
  });

  it("puts the gate back, and records nothing, when the run cannot be started", async () => {
    wired = wireOrchestrator(500);
    const fx = await gateFixture(db);

    await expect(
      caller(db, fx.workspaceId).review.decide({ sessionId: fx.sessionId, decision: "approve" }),
    ).rejects.toThrow();

    expect(await stateOf(db, fx.taskId)).toEqual({ state: "review", failureReason: null });
    expect(await sessionStateOf(db, fx.sessionId)).toBe("awaiting_review");
    expect(await db.select().from(reviewTable)).toHaveLength(0);
  });

  it("applies a decision on a gate an older build declared dead", async () => {
    // `review_decision_not_applied` named a run lost at its `waitForEvent`. There is no run to
    // lose any more, so the decision simply starts one.
    wired = wireOrchestrator();
    const fx = await gateFixture(db);
    await db
      .update(taskTable)
      .set({ failureReason: STRANDED_REVIEW_REASON })
      .where(eq(taskTable.id, fx.taskId));

    await caller(db, fx.workspaceId).review.decide({
      sessionId: fx.sessionId,
      decision: "approve",
    });

    expect(await stateOf(db, fx.taskId)).toEqual({ state: "running", failureReason: null });
    expect(wired.posted).toHaveLength(1);
  });

  it("refuses a decision on a Task that is not at the gate, and records nothing", async () => {
    wired = wireOrchestrator();
    const fx = await gateFixture(db);
    await db.update(taskTable).set({ state: "running" }).where(eq(taskTable.id, fx.taskId));

    await expect(
      caller(db, fx.workspaceId).review.decide({ sessionId: fx.sessionId, decision: "approve" }),
    ).rejects.toThrow(ReviewErrorCode.NotInReview);

    expect(await stateOf(db, fx.taskId)).toEqual({ state: "running", failureReason: null });
    expect(await db.select().from(reviewTable)).toHaveLength(0);
    expect(wired.posted).toHaveLength(0);
  });

  describe("with no orchestrator wired", () => {
    it("refuses Approve rather than claiming an integration nobody performed", async () => {
      const fx = await gateFixture(db);

      for (const decision of ["approve", "request_changes"] as const) {
        await expect(
          caller(db, fx.workspaceId).review.decide({ sessionId: fx.sessionId, decision }),
        ).rejects.toThrow(ReviewErrorCode.NoOrchestrator);
      }

      expect((await stateOf(db, fx.taskId)).state).toBe("review");
      expect(await db.select().from(reviewTable)).toHaveLength(0);
    });

    it("still applies a reject — it is pure state, and it is the way out", async () => {
      const fx = await gateFixture(db);

      await caller(db, fx.workspaceId).review.decide({
        sessionId: fx.sessionId,
        decision: "reject",
      });

      expect((await stateOf(db, fx.taskId)).state).toBe("ready");
    });
  });
});
