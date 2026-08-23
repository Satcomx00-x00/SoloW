import { beforeAll, describe, expect, it } from "bun:test";
import {
  agentCatalog,
  agentProfile,
  encryptSecret,
  executorProfile,
  issue,
  secret,
  session,
  sessionEvent,
  task,
  workspace,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { and, eq } from "drizzle-orm";
import { RECLAIM_STALE_MS, reclaimOrphanedRuns } from "./reconcile.js";

/**
 * Reclaim a Task left `running` by a process that is provably gone (see `reconcile.ts`'s own
 * doc comment for the full incident this answers: an Owner watching a Task's input box answer
 * "No agent is running" forever after an orchestrator restart, because the Inngest Dev Server
 * that would otherwise redrive the workflow had itself lost the in-flight run).
 */

beforeAll(() => {
  process.env.GATECONTROL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
});

const WS = "ws-alpha";

/**
 * A clock far enough past the seeded Session that its quiet period is unambiguously served.
 *
 * Every case below seeds a Session and immediately sweeps, which under the staleness rule is a
 * Task that has been silent for zero milliseconds — i.e. one the sweep must *not* touch. Moving
 * the clock rather than back-dating the rows keeps each test about the thing it is testing.
 */
const LONG_AFTER = () => new Date(Date.now() + RECLAIM_STALE_MS * 2);

async function seedTask(
  db: TestDb,
  opts: { workspaceId?: string; taskId: string; taskState?: "running" | "review" },
) {
  const workspaceId = opts.workspaceId ?? WS;
  const ciphertext = encryptSecret("sk-ant-oat01-super-secret");
  // Every insert here is idempotent-by-id across calls for a shared Workspace (issue #10's
  // catalog/profile rows), so a second `seedTask` for the same Workspace does not collide.
  const [existingWs] = await db.select().from(workspace).where(eq(workspace.id, workspaceId));
  if (!existingWs) {
    await db.insert(workspace).values({ id: workspaceId, name: workspaceId, ownerUserId: "u1" });
    await db.insert(secret).values({
      id: `sec-${workspaceId}`,
      workspaceId,
      name: "claude-token",
      kind: "subscription_token",
      ciphertext,
    });
    await db.insert(agentCatalog).values({
      id: `cat-${workspaceId}`,
      workspaceId,
      key: "claude_code",
      displayName: "Claude Code",
      protocol: "claude_code_stream_json",
      command: "claude",
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
    });
    await db.insert(agentProfile).values({
      id: `ap-${workspaceId}`,
      workspaceId,
      name: "Default Claude",
      agentCatalogId: `cat-${workspaceId}`,
      authMode: "subscription",
      secretId: `sec-${workspaceId}`,
    });
    await db.insert(executorProfile).values({
      id: `ex-${workspaceId}`,
      workspaceId,
      name: "Local",
      kind: "local",
    });
    await db.insert(issue).values({ id: `iss-${workspaceId}`, workspaceId, title: "An issue" });
  }

  await db.insert(task).values({
    id: opts.taskId,
    workspaceId,
    issueId: `iss-${workspaceId}`,
    title: "A task",
    state: opts.taskState ?? "running",
    agentProfileId: `ap-${workspaceId}`,
    executorProfileId: `ex-${workspaceId}`,
  });
  const sessionId = `sess-${opts.taskId}`;
  await db.insert(session).values({ id: sessionId, workspaceId, taskId: opts.taskId });
  return { workspaceId, sessionId };
}

/** A registry that reports nothing live, unless told otherwise — the boot-time case. */
function fakeRegistry(live: ReadonlySet<string> = new Set()) {
  return {
    get: (workspaceId: string, taskId: string) =>
      live.has(`${workspaceId}:${taskId}`)
        ? { taskId, sessionId: "sess-live", handle: {} as never }
        : undefined,
  };
}

function fakeHub() {
  const published: Array<{ channel: string; msg: unknown }> = [];
  return {
    published,
    publish: (channel: string, msg: unknown) => {
      published.push({ channel, msg });
    },
    boardChannel: (workspaceId: string) => `board:${workspaceId}`,
    taskChannel: (workspaceId: string, taskId: string) => `task:${workspaceId}:${taskId}`,
  };
}

describe("reclaimOrphanedRuns", () => {
  it("fails a running Task with no live agent, closing its Session", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-1" });

    const count = await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    expect(count).toBe(1);
    const [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.state).toBe("failed");
    expect(row?.failureReason).toBe("interrupted");
    const [sessRow] = await db.select().from(session).where(eq(session.id, sessionId));
    expect(sessRow?.state).toBe("closed");
    expect(sessRow?.endedAt).not.toBeNull();
  });

  it("records the transition in the Session's own log, not just the row", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-1" });

    await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    const events = await db
      .select()
      .from(sessionEvent)
      .where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.kind, "state")));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      from: "running",
      to: "failed",
      reason: "interrupted",
    });
  });

  it("announces the change to the board and to the Task's own page", async () => {
    // Both, because the person most likely to be waiting on this reclaim is looking at the Task
    // itself — and that page subscribes to the task channel, which this used to skip.
    const db = createTestDb();
    await seedTask(db, { taskId: "task-1" });
    const hub = fakeHub();

    await reclaimOrphanedRuns(db, fakeRegistry(), hub, LONG_AFTER);

    expect(hub.published.map((p) => p.channel)).toEqual([`board:${WS}`, `task:${WS}:task-1`]);
    expect(hub.published[1]?.msg).toMatchObject({ kind: "status", state: "failed" });
    expect(hub.published[0]?.channel).toBe(`board:${WS}`);
    expect(hub.published[0]?.msg).toMatchObject({
      kind: "status",
      taskId: "task-1",
      state: "failed",
    });
  });

  it("leaves a running Task alone when the registry still has its agent", async () => {
    const db = createTestDb();
    await seedTask(db, { taskId: "task-1" });
    const registry = fakeRegistry(new Set([`${WS}:task-1`]));

    const count = await reclaimOrphanedRuns(db, registry, fakeHub(), LONG_AFTER);

    expect(count).toBe(0);
    const [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.state).toBe("running");
  });

  it("leaves a Task in a state other than running untouched", async () => {
    const db = createTestDb();
    await seedTask(db, { taskId: "task-1", taskState: "review" });

    const count = await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    expect(count).toBe(0);
    const [row] = await db.select().from(task).where(eq(task.id, "task-1"));
    expect(row?.state).toBe("review");
  });

  it("reclaims across every Workspace, each keyed correctly", async () => {
    const db = createTestDb();
    await seedTask(db, { workspaceId: "ws-a", taskId: "task-a" });
    await seedTask(db, { workspaceId: "ws-b", taskId: "task-b" });

    const count = await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    expect(count).toBe(2);
    const rows = await db.select({ id: task.id, state: task.state }).from(task);
    expect(rows.every((r) => r.state === "failed")).toBe(true);
  });
});

/**
 * The staleness rule, and the incident that made the sweep periodic.
 *
 * The sweep used to run exactly once, twenty seconds after boot. On the day this was reported it
 * did its job at 11:52:37 — it looked at a `running` Task, found the run genuinely alive and
 * registered, and correctly left it alone. That run died at 13:54 with its work committed and its
 * last turn written, and nothing ever looked again: the Task sat in `running`, its input box
 * answering "No agent is running", until an Owner asked why. Running on a timer is the fix, and a
 * timer needs a second signal — the registry is empty in the short gaps between durable steps
 * too, and a sweep that fired in one of those would kill a run that was about to finish.
 */
describe("reclaimOrphanedRuns staleness", () => {
  it("leaves a Task alone in the gap between two durable steps", async () => {
    // The moment after `agent-run` returns and before `to-review` commits: nothing is registered,
    // and the Task is milliseconds from finishing normally. Reclaiming here would be the bug.
    const db = createTestDb();
    await seedTask(db, { taskId: "task-fresh" });

    const count = await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), () => new Date());

    expect(count).toBe(0);
    const [row] = await db.select().from(task).where(eq(task.id, "task-fresh"));
    expect(row?.state).toBe("running");
  });

  it("reclaims the same Task once it has been quiet past the window", async () => {
    const db = createTestDb();
    await seedTask(db, { taskId: "task-quiet" });

    const count = await reclaimOrphanedRuns(
      db,
      fakeRegistry(),
      fakeHub(),
      () => new Date(Date.now() + RECLAIM_STALE_MS + 1_000),
    );

    expect(count).toBe(1);
    const [row] = await db.select().from(task).where(eq(task.id, "task-quiet"));
    expect(row?.state).toBe("failed");
  });

  it("measures the quiet from the newest event, not from when the Session opened", async () => {
    // A run that has been going for hours is not stale — a long Session whose agent is still
    // talking is the *most* alive thing on the board, and keying off the Session's start would
    // reclaim it on the sweep after its first ten minutes.
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-chatty" });
    const now = Date.now();
    await db.insert(sessionEvent).values({
      id: "ev-recent",
      workspaceId: WS,
      sessionId,
      seq: 0,
      kind: "assistant_turn",
      payload: { kind: "assistant_turn", text: "still here", thinking: false },
      at: new Date(now + RECLAIM_STALE_MS).toISOString(),
    });

    const count = await reclaimOrphanedRuns(
      db,
      fakeRegistry(),
      fakeHub(),
      () => new Date(now + RECLAIM_STALE_MS + 1_000),
    );

    expect(count).toBe(0);
  });
});
