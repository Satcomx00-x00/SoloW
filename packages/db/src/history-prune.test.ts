/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import {
  HISTORY_KEPT_EVENT_KINDS,
  HISTORY_PRUNED_EVENT_KINDS,
  HISTORY_RETENTION_DEFAULT_DAYS,
} from "@solow/contracts";
import { and, eq } from "drizzle-orm";
import { previewHistoryPrune, pruneHistory } from "./history-prune.js";
import {
  executorProfile,
  harnessCatalog,
  harnessProfile,
  issue,
  review,
  secret,
  session,
  sessionEvent,
  sessionSummary,
  sessionUsage,
  task,
  workspace,
} from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";

/**
 * History retention's transcript half (Decision 0032), against a real migrated SQLite database:
 * which Sessions are due, what is removed from them, and — the half that matters to everything
 * else reading this data — what is left exactly as it was.
 */

const WS = "ws-a";
const OTHER = "ws-b";
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const NOW = new Date("2026-10-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const noPause = async () => {};

let db: TestDb;

async function seedWorkspace(id: string, days: number | null | undefined) {
  await db.insert(workspace).values({
    id,
    name: id,
    ownerUserId: `owner-${id}`,
    ...(days === undefined ? {} : { historyRetentionDays: days }),
  });
  await db.insert(harnessCatalog).values({
    id: `cat-${id}`,
    workspaceId: id,
    key: "claude_code",
    displayName: "Claude Code",
    protocol: "claude_code_stream_json",
    command: "claude",
    subscriptionEnvVar: "X",
    meteredEnvVar: "Y",
  });
  await db.insert(secret).values({
    id: `sec-${id}`,
    workspaceId: id,
    name: "token",
    kind: "subscription_token",
    ciphertext: "c",
  });
  await db.insert(harnessProfile).values({
    id: `hp-${id}`,
    workspaceId: id,
    name: "p",
    agentCatalogId: `cat-${id}`,
    authMode: "subscription",
    secretId: `sec-${id}`,
  });
  await db.insert(executorProfile).values({ id: `ep-${id}`, workspaceId: id, name: "Local" });
  await db.insert(issue).values({ id: `iss-${id}`, workspaceId: id, title: "i" });
}

/** One transcript line of every pruned kind, and one row of every kept kind. */
const TRANSCRIPT = HISTORY_PRUNED_EVENT_KINDS.map((kind) => ({ kind, text: `${kind} words` }));
const PATCH = "diff --git a/x b/x\n+".padEnd(4000, "x");

async function seedTask(
  id: string,
  opts: {
    workspaceId?: string;
    state?: "done" | "running" | "review" | "failed";
    updatedAt?: string;
    deletedAt?: string;
    sessionState?: "active" | "resumable" | "closed";
    forkSessionId?: string;
  },
) {
  const w = opts.workspaceId ?? WS;
  await db.insert(task).values({
    id,
    workspaceId: w,
    issueId: `iss-${w}`,
    title: id,
    state: opts.state ?? "done",
    agentProfileId: `hp-${w}`,
    executorProfileId: `ep-${w}`,
    updatedAt: opts.updatedAt ?? ago(60 * DAY),
    deletedAt: opts.deletedAt ?? null,
    ...(opts.forkSessionId
      ? { forkSessionId: opts.forkSessionId, forkSeq: 0, forkHash: "sha256:x" }
      : {}),
  });
  const sessionId = `s-${id}`;
  await db.insert(session).values({
    id: sessionId,
    workspaceId: w,
    taskId: id,
    state: opts.sessionState ?? "closed",
    endedAt: opts.sessionState === "active" ? null : ago(60 * DAY),
  });
  let seq = 0;
  for (const payload of TRANSCRIPT) {
    await db
      .insert(sessionEvent)
      .values({ workspaceId: w, sessionId, seq: seq++, kind: payload.kind, payload });
  }
  const kept = [
    { kind: "state", from: "running", to: "review" },
    { kind: "workflow_decision", stepId: "st", stepName: "Implement", status: "advanced" },
    { kind: "agent_done", changed: true, branch: "solow/x" },
    {
      kind: "diff",
      diffRef: "solow/x",
      files: [{ path: "x", status: "modified", additions: 3, deletions: 1 }],
      patch: PATCH,
      truncated: false,
    },
    { kind: "state", from: "review", to: "done" },
  ];
  for (const payload of kept) {
    await db
      .insert(sessionEvent)
      .values({ workspaceId: w, sessionId, seq: seq++, kind: payload.kind, payload });
  }
  await db.insert(sessionSummary).values({
    workspaceId: w,
    sessionId,
    fromSeq: 0,
    toSeq: 3,
    eventCount: 4,
    text: "summary",
  });
  await db.insert(sessionUsage).values({
    workspaceId: w,
    sessionId,
    taskId: id,
    agentProfileId: `hp-${w}`,
    messageId: `m-${id}`,
    seq: 0,
    model: "m",
    inputTokens: 1200,
    outputTokens: 340,
  });
  await db.insert(review).values({
    workspaceId: w,
    sessionId,
    decision: "approve",
    actorUserId: "u",
  });
  return sessionId;
}

async function kindsOf(sessionId: string) {
  const rows = await db
    .select({ kind: sessionEvent.kind })
    .from(sessionEvent)
    .where(eq(sessionEvent.sessionId, sessionId))
    .orderBy(sessionEvent.seq);
  return rows.map((r) => r.kind);
}

async function prunedAt(sessionId: string) {
  const [row] = await db
    .select({ at: session.eventsPrunedAt })
    .from(session)
    .where(eq(session.id, sessionId));
  return row?.at ?? null;
}

const ALL_KINDS = [
  ...HISTORY_PRUNED_EVENT_KINDS,
  "state",
  "workflow_decision",
  "agent_done",
  "diff",
  "state",
];
const KEPT_KINDS = ["state", "workflow_decision", "agent_done", "diff", "state"];

beforeEach(async () => {
  db = createTestDb();
  await seedWorkspace(WS, 30);
});

describe("which Sessions are due", () => {
  it("prunes a Task Done a minute past the window, and not one a minute inside it", async () => {
    const past = await seedTask("past", { updatedAt: ago(30 * DAY + MINUTE) });
    const inside = await seedTask("inside", { updatedAt: ago(30 * DAY - MINUTE) });

    const report = await pruneHistory(db, { now: NOW, pause: noPause });

    expect(report.sessions).toBe(1);
    expect(report.events).toBe(HISTORY_PRUNED_EVENT_KINDS.length);
    expect(await kindsOf(past)).toEqual(KEPT_KINDS);
    expect(await prunedAt(past)).toBe(NOW.toISOString());
    expect(await kindsOf(inside)).toEqual(ALL_KINDS);
    expect(await prunedAt(inside)).toBeNull();
  });

  it("counts a deleted Task's window from its deletion, whatever state it was left in", async () => {
    const deleted = await seedTask("deleted", {
      state: "review",
      updatedAt: ago(90 * DAY),
      deletedAt: ago(31 * DAY),
    });
    const recent = await seedTask("recent", {
      updatedAt: ago(90 * DAY),
      deletedAt: ago(2 * DAY),
    });

    await pruneHistory(db, { now: NOW, pause: noPause });

    expect(await kindsOf(deleted)).toEqual(KEPT_KINDS);
    expect(await kindsOf(recent)).toEqual(ALL_KINDS);
  });

  it("never touches a Task that is not finished, however old its rows are", async () => {
    const running = await seedTask("running", {
      state: "running",
      updatedAt: ago(400 * DAY),
      sessionState: "active",
    });
    const review = await seedTask("review", { state: "review", updatedAt: ago(400 * DAY) });
    const failed = await seedTask("failed", { state: "failed", updatedAt: ago(400 * DAY) });

    const report = await pruneHistory(db, { now: NOW, pause: noPause });

    expect(report).toEqual({ sessions: 0, events: 0, diffs: 0, more: false });
    for (const id of [running, review, failed]) expect(await kindsOf(id)).toEqual(ALL_KINDS);
  });

  it("leaves a Done Task alone while any of its Sessions is live again", async () => {
    const old = await seedTask("reopened", { updatedAt: ago(60 * DAY) });
    await db
      .insert(session)
      .values({ id: "s-reopened-2", workspaceId: WS, taskId: "reopened", state: "active" });

    await pruneHistory(db, { now: NOW, pause: noPause });

    expect(await kindsOf(old)).toEqual(ALL_KINDS);
  });

  it("keeps a parent's transcript while a sub-task is still waiting to fork from it", async () => {
    const parent = await seedTask("parent", { updatedAt: ago(60 * DAY) });
    await seedTask("child", {
      state: "review",
      updatedAt: NOW.toISOString(),
      forkSessionId: parent,
    });

    await pruneHistory(db, { now: NOW, pause: noPause });
    expect(await kindsOf(parent)).toEqual(ALL_KINDS);

    // Once the child is done with it, the parent's ordinary window applies.
    await db.update(task).set({ state: "done" }).where(eq(task.id, "child"));
    await pruneHistory(db, { now: NOW, pause: noPause });
    expect(await kindsOf(parent)).toEqual(KEPT_KINDS);
  });

  it("keeps forever when the window is null, and touches only its own Workspace", async () => {
    await seedWorkspace(OTHER, null);
    const kept = await seedTask("forever", { workspaceId: OTHER, updatedAt: ago(4000 * DAY) });
    const mine = await seedTask("mine", { updatedAt: ago(60 * DAY) });

    await pruneHistory(db, { now: NOW, pause: noPause });

    expect(await kindsOf(kept)).toEqual(ALL_KINDS);
    expect(await prunedAt(kept)).toBeNull();
    expect(await kindsOf(mine)).toEqual(KEPT_KINDS);
    expect(previewHistoryPrune(db, OTHER, null, NOW)).toEqual({
      tasks: 0,
      sessions: 0,
      events: 0,
      diffs: 0,
    });
  });
});

describe("what stays", () => {
  it("keeps every row the History page and the outcome metrics read", async () => {
    const id = await seedTask("metrics", { updatedAt: ago(60 * DAY) });
    const before = {
      task: await db.select().from(task).where(eq(task.id, "metrics")),
      usage: await db.select().from(sessionUsage).where(eq(sessionUsage.sessionId, id)),
      review: await db.select().from(review).where(eq(review.sessionId, id)),
      summary: await db.select().from(sessionSummary).where(eq(sessionSummary.sessionId, id)),
      kept: await db
        .select()
        .from(sessionEvent)
        .where(and(eq(sessionEvent.sessionId, id), eq(sessionEvent.kind, "state"))),
    };

    await pruneHistory(db, { now: NOW, pause: noPause });

    expect(await db.select().from(task).where(eq(task.id, "metrics"))).toEqual(before.task);
    expect(await db.select().from(sessionUsage).where(eq(sessionUsage.sessionId, id))).toEqual(
      before.usage,
    );
    expect(await db.select().from(review).where(eq(review.sessionId, id))).toEqual(before.review);
    expect(await db.select().from(sessionSummary).where(eq(sessionSummary.sessionId, id))).toEqual(
      before.summary,
    );
    expect(
      await db
        .select()
        .from(sessionEvent)
        .where(and(eq(sessionEvent.sessionId, id), eq(sessionEvent.kind, "state"))),
    ).toEqual(before.kept);
    // The Session row is still there — only marked.
    const [row] = await db.select().from(session).where(eq(session.id, id));
    expect(row?.state).toBe("closed");
    expect(row?.endedAt).not.toBeNull();
  });

  it("empties a diff's patch and keeps its file list and line counts", async () => {
    const id = await seedTask("diffed", { updatedAt: ago(60 * DAY) });

    const report = await pruneHistory(db, { now: NOW, pause: noPause });

    expect(report.diffs).toBe(1);
    const [diff] = await db
      .select({ payload: sessionEvent.payload })
      .from(sessionEvent)
      .where(and(eq(sessionEvent.sessionId, id), eq(sessionEvent.kind, "diff")));
    expect(diff?.payload).toEqual({
      kind: "diff",
      diffRef: "solow/x",
      files: [{ path: "x", status: "modified", additions: 3, deletions: 1 }],
      patch: "",
      truncated: true,
    });
  });

  it("classifies every event kind exactly once", () => {
    const kinds = [...HISTORY_PRUNED_EVENT_KINDS, ...HISTORY_KEPT_EVENT_KINDS];
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(15);
  });
});

describe("bounded batches", () => {
  it("stops at the event bound, leaves the Session unmarked, and finishes on the next sweep", async () => {
    const id = await seedTask("big", { updatedAt: ago(60 * DAY) });
    let pauses = 0;
    const pause = async () => {
      pauses += 1;
    };

    const first = await pruneHistory(db, { now: NOW, batchSize: 3, maxEvents: 5, pause });
    expect(first).toEqual({ sessions: 0, events: 5, diffs: 0, more: true });
    expect(pauses).toBeGreaterThan(0);
    expect(await prunedAt(id)).toBeNull();

    const second = await pruneHistory(db, { now: NOW, batchSize: 3, pause });
    expect(second.sessions).toBe(1);
    expect(second.events).toBe(HISTORY_PRUNED_EVENT_KINDS.length - 5);
    expect(await kindsOf(id)).toEqual(KEPT_KINDS);

    // And a third finds nothing left to do.
    expect(await pruneHistory(db, { now: NOW, pause })).toEqual({
      sessions: 0,
      events: 0,
      diffs: 0,
      more: false,
    });
  });
});

describe("the preview", () => {
  it("counts exactly what the sweep then removes", async () => {
    await seedTask("one", { updatedAt: ago(60 * DAY) });
    await seedTask("two", { updatedAt: ago(10 * DAY) });

    const at30 = previewHistoryPrune(db, WS, 30, NOW);
    const at7 = previewHistoryPrune(db, WS, 7, NOW);
    expect(at30).toMatchObject({ tasks: 1, sessions: 1, events: TRANSCRIPT.length, diffs: 1 });
    expect(at7).toMatchObject({ tasks: 2, sessions: 2, events: 2 * TRANSCRIPT.length, diffs: 2 });

    const report = await pruneHistory(db, { now: NOW, pause: noPause });
    expect(report).toMatchObject({ events: at30.events, diffs: at30.diffs });
    expect(previewHistoryPrune(db, WS, 30, NOW).events).toBe(0);
  });
});

describe("the preview's cost", () => {
  /**
   * Every statement the preview sends, captured on the way to SQLite. Settings asks for a preview
   * from the web process, synchronously, for each window the Owner considers; it has to count
   * rows from an index and never read a transcript's payload to do it.
   */
  function capture(run: () => void): Array<{ sql: string; params: unknown[] }> {
    const client = db.$client;
    const original = client.prepare.bind(client);
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    client.prepare = ((query: string, ...rest: unknown[]) => {
      const statement = original(query, ...(rest as []));
      const record = { sql: query, params: [] as unknown[] };
      seen.push(record);
      for (const method of ["get", "all", "values", "run"] as const) {
        const call = statement[method].bind(statement) as (...args: unknown[]) => unknown;
        (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
          record.params = args;
          return call(...args);
        };
      }
      return statement;
    }) as typeof client.prepare;
    try {
      run();
    } finally {
      client.prepare = original;
    }
    return seen;
  }

  it("counts from an index and never reads an event's payload", async () => {
    await seedTask("old", { updatedAt: ago(60 * DAY) });

    const statements = capture(() => previewHistoryPrune(db, WS, 7, NOW));
    expect(statements.length).toBeGreaterThan(0);

    for (const { sql, params } of statements) {
      expect(sql).not.toContain("payload");
      const plan = db.$client
        .query(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...(params as never[])) as Array<{ detail: string }>;
      const onEvents = plan.map((p) => p.detail).filter((d) => / session_event\b/.test(d));
      expect(onEvents.length).toBeGreaterThan(0);
      // A covering index answers from the index alone: the row, and its payload, is never read.
      for (const detail of onEvents) expect(detail).toContain("USING COVERING INDEX");
    }
  });
});

describe("the column", () => {
  it("defaults a new Workspace to the product's default window", async () => {
    await seedWorkspace(OTHER, undefined);
    const [row] = await db
      .select({ days: workspace.historyRetentionDays })
      .from(workspace)
      .where(eq(workspace.id, OTHER));
    expect(row?.days).toBe(HISTORY_RETENTION_DEFAULT_DAYS);
  });
});
