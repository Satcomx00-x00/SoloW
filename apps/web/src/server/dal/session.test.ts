import { beforeEach, describe, expect, it } from "bun:test";
import { session, sessionEvent, sessionSummary } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import {
  appendSessionEvent,
  listSessionEvents,
  listSessionEventsFrom,
  listSessionEventsInRange,
  listSessionSummaries,
  sessionForkCursor,
} from "./session.js";
import { createTaskRecord } from "./task.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * The web app is the second writer of the session log, and the reader the review page uses
 * (issue #2). What matters here is that both eras of row read back typed, that a fork cursor
 * refuses a rewritten history, and that neither crosses a Workspace boundary (Principle V).
 */

async function seedSession(db: TestDb, name: string) {
  const graph = await seedWorkspaceGraph(db, name);
  const iss = await seedIssue(db, graph.workspaceId);
  const ctx = ctxFor(db, graph.workspaceId);
  const created = await createTaskRecord(ctx, {
    issueId: iss.id,
    title: "Fix the latch",
    agentProfileId: graph.agentProfileId,
    executorProfileId: graph.executorProfileId,
    repositories: [{ repositoryId: graph.repositoryId }],
    state: "backlog",
  });
  if (!created.ok) throw new Error("failed to seed task");
  const [row] = await db
    .insert(session)
    .values({ workspaceId: graph.workspaceId, taskId: created.data.id, state: "active" })
    .returning();
  if (!row) throw new Error("failed to seed session");
  return { ctx, workspaceId: graph.workspaceId, sessionId: row.id };
}

describe("session DAL — the typed log (issue #2)", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("reads a Session's events back typed, whether or not the union existed when they were written", async () => {
    const { ctx, workspaceId, sessionId } = await seedSession(db, "acme");
    // Written now…
    const written = await appendSessionEvent(ctx, {
      sessionId,
      seq: 0,
      payload: { kind: "user_turn", text: "fix the latch" },
    });
    expect(written.ok).toBe(true);
    // …and written by an earlier run, straight into the table under a transport-word kind.
    await db.insert(sessionEvent).values({
      workspaceId,
      sessionId,
      seq: 1,
      kind: "stdout",
      payload: { text: "patched latch.ts\n" },
    });

    const events = await listSessionEvents(ctx, sessionId);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.data.map((e) => e.payload)).toEqual([
      { kind: "user_turn", text: "fix the latch" },
      { kind: "assistant_turn", text: "patched latch.ts\n", thinking: false },
    ]);
    // The DTO's kind mirrors the payload's, so a caller never has to consult both.
    expect(events.data.map((e) => e.kind)).toEqual(["user_turn", "assistant_turn"]);
  });

  it("refuses to write a payload the union does not admit", async () => {
    const { ctx, sessionId } = await seedSession(db, "acme");
    await expect(
      appendSessionEvent(ctx, {
        sessionId,
        seq: 0,
        payload: { kind: "stdout", text: "working" } as never,
      }),
    ).rejects.toThrow();
    const events = await listSessionEvents(ctx, sessionId);
    expect(events.ok && events.data).toHaveLength(0);
  });

  it("mints a fork cursor at the head of the log and reads the events after it", async () => {
    const { ctx, sessionId } = await seedSession(db, "acme");
    for (let seq = 0; seq < 3; seq++) {
      await appendSessionEvent(ctx, {
        sessionId,
        seq,
        payload: { kind: "assistant_turn", text: `line ${seq}`, thinking: false },
      });
    }

    const cursor = await sessionForkCursor(ctx, sessionId, 0);
    expect(cursor.ok).toBe(true);
    if (!cursor.ok) return;

    const after = await listSessionEventsFrom(ctx, cursor.data);
    expect(after.ok).toBe(true);
    expect(after.ok && after.data.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("has no fork cursor for a Session that has recorded nothing yet", async () => {
    const { ctx, sessionId } = await seedSession(db, "acme");
    const cursor = await sessionForkCursor(ctx, sessionId);
    expect(cursor.ok).toBe(false);
    expect(!cursor.ok && cursor.error).toBe("NOT_FOUND");
  });

  it("refuses a cursor whose history was rewritten underneath it", async () => {
    const { ctx, sessionId } = await seedSession(db, "acme");
    for (let seq = 0; seq < 3; seq++) {
      await appendSessionEvent(ctx, {
        sessionId,
        seq,
        payload: { kind: "assistant_turn", text: `line ${seq}`, thinking: false },
      });
    }
    const cursor = await sessionForkCursor(ctx, sessionId);
    if (!cursor.ok) throw new Error("expected a cursor");

    await db
      .update(sessionEvent)
      .set({ payload: { kind: "assistant_turn", text: "rewritten", thinking: false } })
      .where(eq(sessionEvent.seq, 1));

    const after = await listSessionEventsFrom(ctx, cursor.data);
    expect(after.ok).toBe(false);
    expect(!after.ok && after.error).toBe("SESSION_CURSOR_STALE");
    // Distinguished from a point that is simply gone — only one of the two is evidence of a
    // rewrite, and a caller resuming from a fork needs to be told which happened.
    await db.delete(sessionEvent).where(eq(sessionEvent.seq, 2));
    const gone = await listSessionEventsFrom(ctx, cursor.data);
    expect(!gone.ok && gone.error).toBe("NOT_FOUND");
  });

  it("refuses a cursor after an undeclared key on a stored payload was changed", async () => {
    // The union strips keys it does not declare, so a cursor that hashed the *parsed* payload
    // would call this log intact. What the cursor claims is that the row has not been rewritten.
    const { ctx, sessionId } = await seedSession(db, "acme");
    await appendSessionEvent(ctx, {
      sessionId,
      seq: 0,
      payload: { kind: "assistant_turn", text: "line 0", thinking: false },
    });
    const cursor = await sessionForkCursor(ctx, sessionId);
    if (!cursor.ok) throw new Error("expected a cursor");

    await db
      .update(sessionEvent)
      .set({
        payload: { kind: "assistant_turn", text: "line 0", thinking: false, tampered: "yes" },
      })
      .where(eq(sessionEvent.seq, 0));

    const after = await listSessionEventsFrom(ctx, cursor.data);
    expect(after.ok).toBe(false);
    expect(!after.ok && after.error).toBe("SESSION_CURSOR_STALE");
  });

  it("does not mint a cursor over another Workspace's log (Principle V)", async () => {
    const alpha = await seedSession(db, "alpha");
    const beta = await seedSession(db, "beta");
    await appendSessionEvent(alpha.ctx, {
      sessionId: alpha.sessionId,
      seq: 0,
      payload: { kind: "assistant_turn", text: "line 0", thinking: false },
    });

    // Beta naming alpha's Session id sees an empty log, so there is no fork point to offer.
    const theirs = await sessionForkCursor(beta.ctx, alpha.sessionId);
    expect(theirs.ok).toBe(false);
    expect(!theirs.ok && theirs.error).toBe("NOT_FOUND");
  });

  it("reads back one summarised range and nothing outside it", async () => {
    const { ctx, sessionId } = await seedSession(db, "acme");
    for (let seq = 0; seq < 5; seq++) {
      await appendSessionEvent(ctx, {
        sessionId,
        seq,
        payload: { kind: "assistant_turn", text: `line ${seq}`, thinking: false },
      });
    }

    const range = await listSessionEventsInRange(ctx, { sessionId, fromSeq: 1, toSeq: 3 });
    expect(range.ok && range.data.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("does not return another Workspace's range (Principle V)", async () => {
    const alpha = await seedSession(db, "alpha");
    const beta = await seedSession(db, "beta");
    await appendSessionEvent(alpha.ctx, {
      sessionId: alpha.sessionId,
      seq: 0,
      payload: { kind: "assistant_turn", text: "line 0", thinking: false },
    });

    const theirs = await listSessionEventsInRange(beta.ctx, {
      sessionId: alpha.sessionId,
      fromSeq: 0,
      toSeq: 9,
    });
    expect(theirs.ok && theirs.data).toHaveLength(0);
  });

  it("does not return another Workspace's summaries (Principle V)", async () => {
    const alpha = await seedSession(db, "alpha");
    const beta = await seedSession(db, "beta");
    await db.insert(sessionSummary).values({
      workspaceId: alpha.workspaceId,
      sessionId: alpha.sessionId,
      fromSeq: 0,
      toSeq: 9,
      eventCount: 10,
      text: "10 events",
    });

    expect((await listSessionSummaries(alpha.ctx, alpha.sessionId)).ok).toBe(true);
    const mine = await listSessionSummaries(alpha.ctx, alpha.sessionId);
    expect(mine.ok && mine.data).toHaveLength(1);
    // Beta naming alpha's Session id gets nothing back — the query is Workspace-scoped, so a
    // leaked id is not a way in.
    const theirs = await listSessionSummaries(beta.ctx, alpha.sessionId);
    expect(theirs.ok && theirs.data).toHaveLength(0);
  });
});
