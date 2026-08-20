/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import {
  agentProfile,
  ensureDefaultAgentCatalog,
  executorProfile,
  issue as issueTable,
  repository,
  secret,
  sessionEvent,
  sessionSummary,
  session as sessionTable,
  taskRepository,
  task as taskTable,
  workspace,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The fork cursor at the API boundary (issue #2, AC-4), and the property the migration was
 * designed around: a Session recorded before the typed union still reads back as a transcript.
 *
 * The refusal is asserted here rather than only in the pure function because that is where a
 * caller actually meets it — #9 will fork a sub-task through this procedure, and a stale cursor
 * has to come back as a refusal, not as events from a history nobody promised.
 */

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

const caller = (db: TestDb, workspaceId: string) => appRouter.createCaller(ctx(db, workspaceId));

async function fixture(db: TestDb) {
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
      agentProfileId: agent?.id ?? "",
      executorProfileId: executor?.id ?? "",
    })
    .returning();
  if (!task || !repo) throw new Error("failed to seed task");
  await db.insert(taskRepository).values({
    workspaceId: ws.id,
    taskId: task.id,
    repositoryId: repo.id,
    checkoutBranch: `gatecontrol/task-${task.id}`,
    position: 0,
  });
  const [session] = await db
    .insert(sessionTable)
    .values({ workspaceId: ws.id, taskId: task.id, state: "awaiting_review" })
    .returning();
  if (!session) throw new Error("failed to seed session");
  return { workspaceId: ws.id, sessionId: session.id };
}

/** Write a row the way an earlier run did: opaque payload under a transport-word kind. */
const legacyRow = (
  db: TestDb,
  fx: { workspaceId: string; sessionId: string },
  seq: number,
  kind: string,
  payload: unknown,
) =>
  db.insert(sessionEvent).values({
    workspaceId: fx.workspaceId,
    sessionId: fx.sessionId,
    seq,
    kind,
    payload,
  });

const typedRow = (
  db: TestDb,
  fx: { workspaceId: string; sessionId: string },
  seq: number,
  text: string,
) =>
  db.insert(sessionEvent).values({
    workspaceId: fx.workspaceId,
    sessionId: fx.sessionId,
    seq,
    kind: "assistant_turn",
    payload: { kind: "assistant_turn", text, thinking: false },
  });

describe("session.get (issue #2)", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("returns a null cursor for a Session that has recorded nothing yet", async () => {
    const fx = await fixture(db);
    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });
    expect(detail.cursor).toBeNull();
    expect(detail.summaries).toEqual([]);
  });

  it("returns the head fork cursor alongside the events", async () => {
    const fx = await fixture(db);
    for (let seq = 0; seq < 3; seq++) await typedRow(db, fx, seq, `line ${seq}`);

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });
    expect(detail.cursor?.sessionId).toBe(fx.sessionId);
    expect(detail.cursor?.seq).toBe(2);
    expect(detail.cursor?.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("still shows the transcript and the diff for a Session recorded before the union existed", async () => {
    // The property the migration exists to protect: nothing rewrote these rows, so an approved
    // Task can still show what was approved (Principle I).
    const fx = await fixture(db);
    await legacyRow(db, fx, 0, "stdout", { text: "patched latch.ts\n" });
    await legacyRow(db, fx, 1, "tool_use", { name: "Edit" });
    await legacyRow(db, fx, 2, "diff", {
      diffRef: "gatecontrol/task-1",
      files: [{ path: "src/latch.ts", status: "modified", additions: 3, deletions: 1 }],
      patch: "@@ -1 +1 @@",
      truncated: false,
    });

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });
    expect(detail.events.map((e) => e.kind)).toEqual(["assistant_turn", "tool_call", "diff"]);
    expect(detail.diff?.diffRef).toBe("gatecontrol/task-1");
    expect(detail.diff?.files).toHaveLength(1);
  });

  it("reports the ranges compaction has summarised", async () => {
    const fx = await fixture(db);
    for (let seq = 0; seq < 3; seq++) await typedRow(db, fx, seq, `line ${seq}`);
    await db.insert(sessionSummary).values({
      workspaceId: fx.workspaceId,
      sessionId: fx.sessionId,
      fromSeq: 0,
      toSeq: 1,
      eventCount: 2,
      text: "2 events — 2 assistant turns",
    });

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });
    expect(detail.summaries).toHaveLength(1);
    expect(detail.summaries[0]).toMatchObject({ fromSeq: 0, toSeq: 1, eventCount: 2 });
    // The summary stands in for its range: the response carries the tail and the summary, not
    // the events the summary already describes. That is the reduction compaction is for — a
    // response that carried both would leave a long run growing without bound on the wire.
    expect(detail.events.map((e) => e.seq)).toEqual([2]);
  });

  it("reads a summarised range back on demand, because compaction removed nothing (AC-2)", async () => {
    const fx = await fixture(db);
    for (let seq = 0; seq < 3; seq++) await typedRow(db, fx, seq, `line ${seq}`);
    await db.insert(sessionSummary).values({
      workspaceId: fx.workspaceId,
      sessionId: fx.sessionId,
      fromSeq: 0,
      toSeq: 1,
      eventCount: 2,
      text: "2 events — 2 assistant turns",
    });

    const range = await caller(db, fx.workspaceId).session.eventRange({
      sessionId: fx.sessionId,
      fromSeq: 0,
      toSeq: 1,
    });
    expect(range.map((e) => e.seq)).toEqual([0, 1]);
    expect(range.map((e) => e.payload)).toEqual([
      { kind: "assistant_turn", text: "line 0", thinking: false },
      { kind: "assistant_turn", text: "line 1", thinking: false },
    ]);
  });

  it("still reports the diff and the head cursor when the range that holds them is summarised", async () => {
    // The elision is a view. Everything the response *derives* from the log — the change a
    // reviewer decides on, the fork point — is computed from all of it.
    const fx = await fixture(db);
    await legacyRow(db, fx, 0, "diff", {
      diffRef: "gatecontrol/task-1",
      files: [{ path: "src/latch.ts", status: "modified", additions: 3, deletions: 1 }],
      patch: "@@ -1 +1 @@",
      truncated: false,
    });
    await typedRow(db, fx, 1, "line 1");
    await db.insert(sessionSummary).values({
      workspaceId: fx.workspaceId,
      sessionId: fx.sessionId,
      fromSeq: 0,
      toSeq: 1,
      eventCount: 2,
      text: "2 events",
    });

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });
    expect(detail.events).toEqual([]);
    expect(detail.diff?.diffRef).toBe("gatecontrol/task-1");
    expect(detail.cursor?.seq).toBe(1);
  });

  it("does not read another Workspace's range (Principle V)", async () => {
    const alpha = await fixture(db);
    const beta = await fixture(db);
    for (let seq = 0; seq < 2; seq++) await typedRow(db, alpha, seq, `line ${seq}`);

    await expect(
      caller(db, beta.workspaceId).session.eventRange({
        sessionId: alpha.sessionId,
        fromSeq: 0,
        toSeq: 1,
      }),
    ).rejects.toThrow();
  });
});

describe("session.forkCursor / session.eventsFrom (AC-4)", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("hands back the events recorded after a cursor whose history is intact", async () => {
    const fx = await fixture(db);
    for (let seq = 0; seq < 4; seq++) await typedRow(db, fx, seq, `line ${seq}`);
    const api = caller(db, fx.workspaceId);

    const cursor = await api.session.forkCursor({ sessionId: fx.sessionId, seq: 1 });
    const after = await api.session.eventsFrom(cursor);

    expect(after.map((e) => e.seq)).toEqual([2, 3]);
  });

  it("rejects a stale cursor rather than serving events from it", async () => {
    const fx = await fixture(db);
    for (let seq = 0; seq < 4; seq++) await typedRow(db, fx, seq, `line ${seq}`);
    const api = caller(db, fx.workspaceId);
    const cursor = await api.session.forkCursor({ sessionId: fx.sessionId });

    // Nothing in the product rewrites a session event. The cursor is what proves that.
    await db
      .update(sessionEvent)
      .set({ payload: { kind: "assistant_turn", text: "rewritten", thinking: false } })
      .where(eq(sessionEvent.seq, 1));

    await expect(api.session.eventsFrom(cursor)).rejects.toThrow("SESSION_CURSOR_STALE");
  });

  it("refuses a cursor for a Session in another Workspace (Principle V)", async () => {
    const alpha = await fixture(db);
    const beta = await fixture(db);
    for (let seq = 0; seq < 2; seq++) await typedRow(db, alpha, seq, `line ${seq}`);
    const cursor = await caller(db, alpha.workspaceId).session.forkCursor({
      sessionId: alpha.sessionId,
    });

    await expect(caller(db, beta.workspaceId).session.eventsFrom(cursor)).rejects.toThrow();
  });

  it("has no fork point to mint for a Session that has recorded nothing", async () => {
    const fx = await fixture(db);
    await expect(
      caller(db, fx.workspaceId).session.forkCursor({ sessionId: fx.sessionId }),
    ).rejects.toThrow("NOT_FOUND");
  });
});
