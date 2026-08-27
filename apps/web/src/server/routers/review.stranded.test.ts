/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { STRANDED_REVIEW_REASON } from "@solow/core";
import {
  agentProfile,
  ensureDefaultAgentCatalog,
  executorProfile,
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

/**
 * An approval the API cannot integrate must not be reported as one that was.
 *
 * Observed end to end on 2026-08-27, driving the real app: an agent edited a file, the reviewer
 * approved, the Task went **Done**, and the branch still pointed at the commit before the run.
 * The change sat uncommitted in a worktree nothing would clean up, and there was no error
 * anywhere on screen. That is the worst shape a review gate can fail in — indistinguishable from
 * having worked.
 *
 * The cause is the dev-owner recovery path. When no durable run is parked to receive the
 * decision, the API applies the resulting Task state itself so the local loop stays usable. For
 * `reject` and `request_changes` that is honest: both are pure state, and neither claims anything
 * happened to the work. `approve` claims the opposite — that the change was **integrated** — and
 * integration means reaching a worktree through an Executor, which this process cannot do by
 * design (Principle: the API never touches a working tree).
 *
 * So approve, on that path, now fails the Task with `STRANDED_REVIEW_REASON` — the constant that
 * already names exactly this ("recorded and never applied"), and which the board already renders
 * as "Decision not applied" with a Retry. Nothing is lost: the decision is recorded either way,
 * and the change is intact on its branch.
 */

// Dev-owner is the mode this recovery path exists for, and the one the local stack runs in.
process.env["SOLOW_DEV_OWNER"] = "on";

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

const caller = (db: TestDb, workspaceId: string) => appRouter.createCaller(ctx(db, workspaceId));

/**
 * A Task at the review gate whose Session is **not** `awaiting_review`.
 *
 * That is the tell the router reads for "no run is parked to receive this" — and it is the state
 * the real system was in when the defect was observed: the run never reached its own gate, so
 * the Session was still `active` while the Task sat in `review`.
 */
async function strandedFixture(db: TestDb, sessionState: "active" | "awaiting_review" = "active") {
  const [ws] = await db
    .insert(workspace)
    .values({ name: "Acme", ownerUserId: "owner-1" })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");
  const catalogId = await ensureDefaultAgentCatalog(db, ws.id);
  const [sec] = await db
    .insert(secret)
    .values({ workspaceId: ws.id, name: "token", kind: "subscription_token", ciphertext: "x" })
    .returning();
  const [agent] = await db
    .insert(agentProfile)
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
      agentProfileId: agent?.id ?? "",
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

describe("review.decide when no run is parked to apply it", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("does NOT mark the Task done — nothing was committed", async () => {
    // The defect, stated as the assertion that would have caught it.
    const fx = await strandedFixture(db);

    await caller(db, fx.workspaceId).review.decide({
      sessionId: fx.sessionId,
      decision: "approve",
    });

    const after = await stateOf(db, fx.taskId);
    expect(after.state).not.toBe("done");
    expect(after.state).toBe("failed");
    expect(after.failureReason).toBe(STRANDED_REVIEW_REASON);
  });

  it("still records the decision, because the reviewer really did decide", async () => {
    // The work is intact on its branch and the judgement stands; what failed is the delivery.
    const fx = await strandedFixture(db);

    const review = await caller(db, fx.workspaceId).review.decide({
      sessionId: fx.sessionId,
      decision: "approve",
    });

    expect(review.decision).toBe("approve");
  });

  it("does NOT mark the Task running on request_changes — no process here starts an agent", async () => {
    /*
     * The sibling defect. The durable path resumes the agent because the parked run consumes
     * `review.decided`; on this path nothing does. Writing `running` produced a Task that said
     * an agent was working while no process existed anywhere — the input box answered "No agent
     * is running" until the orchestrator's next boot-time reconcile happened to sweep it.
     */
    const fx = await strandedFixture(db);

    await caller(db, fx.workspaceId).review.decide({
      sessionId: fx.sessionId,
      decision: "request_changes",
      feedback: "tighten the error handling",
    });

    const after = await stateOf(db, fx.taskId);
    expect(after.state).not.toBe("running");
    expect(after.state).toBe("failed");
    expect(after.failureReason).toBe(STRANDED_REVIEW_REASON);
    // And the session is closed, not left `active`: the Issue derives "in progress" from any
    // active session, so a stranded Task would otherwise keep its Issue worked-on forever.
    const [row] = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.id, fx.sessionId))
      .limit(1);
    expect(row?.state).toBe("closed");
  });

  it("leaves a reject alone — it integrates nothing, so it can be applied here", async () => {
    // The distinction the fix rests on: reject and request_changes are pure state.
    const fx = await strandedFixture(db);

    await caller(db, fx.workspaceId).review.decide({
      sessionId: fx.sessionId,
      decision: "reject",
    });

    expect((await stateOf(db, fx.taskId)).state).toBe("ready");
  });

  it("keeps out of the way when a run IS parked to apply the approval", async () => {
    // `awaiting_review` is the tell that the durable run is sitting at its own gate. The Task
    // stays in `review` until that run commits and moves it — writing anything here would race
    // the engine that owns the transition.
    //
    // The wiring is stubbed at `fetch`, not with a real server: this suite runs under happy-dom,
    // whose `Response` is not the one `Bun.serve` hands back, and the point under test is the
    // condition — "there is a URL, and the decision was handed to it" — not the transport.
    const posted: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      posted.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    process.env["SOLOW_ORCHESTRATOR_URL"] = "http://orchestrator.test";
    try {
      const fx = await strandedFixture(db, "awaiting_review");

      await caller(db, fx.workspaceId).review.decide({
        sessionId: fx.sessionId,
        decision: "approve",
      });

      expect((await stateOf(db, fx.taskId)).state).toBe("review");
      // And the decision really was handed to the engine that owns the transition.
      expect(posted.some((url) => url.endsWith("/events"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      Reflect.deleteProperty(process.env, "SOLOW_ORCHESTRATOR_URL");
    }
  });
});
