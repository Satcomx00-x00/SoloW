/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
  ensureDefaultHarnessCatalog,
  executorProfile,
  harnessProfile,
  issue as issueTable,
  repository,
  secret,
  sessionEvent,
  sessionSummary,
  session as sessionTable,
  taskRepository,
  task as taskTable,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The transcript, scoped to one Workflow Step, at the boundary a client actually meets.
 *
 * One Session spans a whole pipeline — every Step, every review round — so a terminal that wants
 * to show one Step has two ways to get there: read the whole log and group it by the Step id each
 * event now carries, or ask for one Step's rows. Both are asserted here, because the second is
 * only worth having if the first keeps working: the Session's own facts — its fork cursor, the
 * diffs captured at the review gate — are about the whole run, and must not change shape because
 * the caller happened to be looking at Step 2.
 */

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

const caller = (db: TestDb, workspaceId: string) => appRouter.createCaller(ctx(db, workspaceId));

/** A Workspace with one Task and one Session, to hang a pipeline's worth of events off. */
async function fixture(db: TestDb) {
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
  const [repo] = await db
    .insert(repository)
    .values({ workspaceId: ws.id, name: "api", source: "local_path", location: "/srv/api" })
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
      title: "Fix the latch",
      state: "review",
      agentProfileId: harness?.id ?? "",
      executorProfileId: executor?.id ?? "",
    })
    .returning();
  if (!task || !repo) throw new Error("failed to seed task");
  await db.insert(taskRepository).values({
    workspaceId: ws.id,
    taskId: task.id,
    repositoryId: repo.id,
    checkoutBranch: `solow/task-${task.id}`,
    position: 0,
  });
  const [session] = await db
    .insert(sessionTable)
    .values({ workspaceId: ws.id, taskId: task.id, state: "awaiting_review" })
    .returning();
  if (!session) throw new Error("failed to seed session");
  return { workspaceId: ws.id, sessionId: session.id };
}

/** One turn of the transcript, attributed to a Step — or to none, which is also an answer. */
const turn = (
  db: TestDb,
  fx: { workspaceId: string; sessionId: string },
  seq: number,
  text: string,
  workflowStepId: string | null,
) =>
  db.insert(sessionEvent).values({
    workspaceId: fx.workspaceId,
    sessionId: fx.sessionId,
    seq,
    kind: "assistant_turn",
    payload: { kind: "assistant_turn", text, thinking: false },
    workflowStepId,
  });

describe("session.get scoped to a Workflow Step", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("returns the whole log, each event naming the Step that produced it, when no Step is asked for", async () => {
    // The default path, unchanged: every event, in order. The Step id rides along so a client can
    // group the transcript itself without a request per Step.
    const fx = await fixture(db);
    await turn(db, fx, 0, "before workflows", null);
    await turn(db, fx, 1, "planning", "step-plan");
    await turn(db, fx, 2, "building", "step-build");

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });
    expect(detail.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(detail.events.map((e) => e.workflowStepId)).toEqual([null, "step-plan", "step-build"]);
  });

  it("returns only that Step's events when one is named", async () => {
    const fx = await fixture(db);
    await turn(db, fx, 0, "before workflows", null);
    await turn(db, fx, 1, "planning", "step-plan");
    await turn(db, fx, 2, "building", "step-build");
    await turn(db, fx, 3, "still building", "step-build");

    const detail = await caller(db, fx.workspaceId).session.get({
      sessionId: fx.sessionId,
      workflowStepId: "step-build",
    });
    expect(detail.events.map((e) => e.seq)).toEqual([2, 3]);
    // The unattributed row is not "everyone's": a Step scope means that Step, and a row nobody
    // can attribute belongs to no Step's view.
    expect(detail.events.every((e) => e.workflowStepId === "step-build")).toBe(true);
  });

  it("leaves the Session's own facts alone when the events are scoped", async () => {
    /*
     * The fork cursor hashes every event up to its `seq`. Minted over one Step's slice it would
     * be a promise about a history that does not exist, and a child run resuming from it would
     * continue from a transcript nobody ever had. So the cursor a scoped request returns is the
     * same cursor an unscoped one returns.
     */
    const fx = await fixture(db);
    await turn(db, fx, 0, "planning", "step-plan");
    await turn(db, fx, 1, "building", "step-build");

    const whole = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });
    const scoped = await caller(db, fx.workspaceId).session.get({
      sessionId: fx.sessionId,
      workflowStepId: "step-build",
    });
    expect(scoped.cursor).toEqual(whole.cursor);
    expect(scoped.session).toEqual(whole.session);
  });

  it("still elides a summarised range inside a Step's own slice", async () => {
    // Compaction and Step scoping are answers to the same problem and must compose: a range a
    // summary already stands in for stays elided, whichever Step the caller asked for.
    const fx = await fixture(db);
    await turn(db, fx, 0, "building", "step-build");
    await turn(db, fx, 1, "still building", "step-build");
    await db.insert(sessionSummary).values({
      workspaceId: fx.workspaceId,
      sessionId: fx.sessionId,
      fromSeq: 0,
      toSeq: 0,
      eventCount: 1,
      text: "1 event — 1 assistant turn",
    });

    const detail = await caller(db, fx.workspaceId).session.get({
      sessionId: fx.sessionId,
      workflowStepId: "step-build",
    });
    expect(detail.events.map((e) => e.seq)).toEqual([1]);
    expect(detail.summaries).toHaveLength(1);
  });

  it("does not reach into another Workspace's Session for a Step (Principle V)", async () => {
    const alpha = await fixture(db);
    const beta = await fixture(db);
    await turn(db, alpha, 0, "building", "step-build");

    // Beta naming alpha's Session is refused where every other read refuses it — on ownership,
    // before the Step id is ever consulted.
    await expect(
      caller(db, beta.workspaceId).session.get({
        sessionId: alpha.sessionId,
        workflowStepId: "step-build",
      }),
    ).rejects.toThrow();
  });
});
