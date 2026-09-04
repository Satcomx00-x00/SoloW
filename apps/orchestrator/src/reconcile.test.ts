import { beforeAll, describe, expect, it } from "bun:test";
import { STRANDED_REVIEW_REASON } from "@solow/core";
import {
  agentCatalog,
  agentProfile,
  encryptSecret,
  executorProfile,
  issue,
  review,
  secret,
  session,
  sessionEvent,
  task,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, eq } from "drizzle-orm";
import { PARK_SLEEP_MS, REVIEW_WAIT_TIMEOUT } from "./inngest/functions/task-run.js";
import {
  PARK_WINDOW_MS,
  RECLAIM_STALE_MS,
  RECOVERED_REASON,
  REVIEW_WAIT_MS,
  reclaimOrphanedRuns,
  reportStrandedParks,
  reportStrandedReviews,
  STRANDED_PARK_REASON,
} from "./reconcile.js";

/**
 * Reclaim a Task left `running` by a process that is provably gone (see `reconcile.ts`'s own
 * doc comment for the full incident this answers: an Owner watching a Task's input box answer
 * "No agent is running" forever after an orchestrator restart, because the Inngest Dev Server
 * that would otherwise redrive the workflow had itself lost the in-flight run).
 */

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
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

/**
 * And the clock a parked Task has to be read against: past the whole quota window it sleeps out.
 *
 * `LONG_AFTER` is *inside* that window, which is the whole point of having both — a Task that
 * parked twenty minutes ago is a Task doing exactly what it is supposed to, and the case below
 * that sweeps it with `LONG_AFTER` would pass just as well against a sweep that had no window at
 * all if this one did not exist to show the difference.
 */
const AFTER_PARK_WINDOW = () => new Date(Date.now() + PARK_WINDOW_MS + RECLAIM_STALE_MS * 2);

/**
 * And the clock a Session left at the review gate has to be read against.
 *
 * A parked round that finished waits in `waitForEvent` for seven days, which is much longer than
 * the park window above — so `AFTER_PARK_WINDOW` is *inside* it, and a case that could only
 * distinguish "waiting for a person" from "nobody is ever coming" needs a clock past the wait the
 * gate itself gives.
 */
const AFTER_REVIEW_WAIT = () => new Date(Date.now() + REVIEW_WAIT_MS + RECLAIM_STALE_MS * 2);

async function seedTask(
  db: TestDb,
  opts: { workspaceId?: string; taskId: string; taskState?: "running" | "review" | "parked" },
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

/**
 * A run that finished and was then lost, which is the case that filled the Failed column.
 *
 * The agent did the work, wrote its last turn and committed. The step that would have moved the
 * Task to review never ran — a restart, a `bun --hot` reload, an engine that dropped the run —
 * and nothing anywhere recorded that the agent had ever finished. This sweep found a `running`
 * Task with no agent and did the only safe thing available to it: `failed`, `interrupted`. Work
 * that was done, and committed, filed as a failure.
 *
 * `agent_done` is what makes the two distinguishable, so these are the two halves of one rule.
 */
describe("reclaimOrphanedRuns after the agent finished", () => {
  async function seedWithMarker(db: TestDb, taskId: string, branch: string) {
    const { sessionId } = await seedTask(db, { taskId });
    await db.insert(sessionEvent).values({
      id: `ev-done-${taskId}`,
      workspaceId: WS,
      sessionId,
      seq: 0,
      kind: "agent_done",
      payload: { kind: "agent_done", changed: true, branch },
      at: new Date().toISOString(),
    });
    return sessionId;
  }

  it("records the declaration and leaves the Task for a person, not in failed", async () => {
    // The Task does not move: entering review is the operator's one action (Principle I), and
    // the sweep has no more standing to open the gate than the run did.
    const db = createTestDb();
    const sessionId = await seedWithMarker(db, "task-finished", "solow/task-finished");

    const count = await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    expect(count).toBe(1);
    const [row] = await db.select().from(task).where(eq(task.id, "task-finished"));
    expect(row?.state).toBe("running");
    expect(row?.completedAt).not.toBeNull();
    // No failure reason: nothing failed.
    expect(row?.failureReason).toBeNull();

    const [live] = await db.select().from(session).where(eq(session.id, sessionId));
    expect(live?.state).toBe("awaiting_review");
    // The branch the marker carried — what the reviewer opens, and the only thing the gate
    // strictly needs.
    expect(live?.diffRef).toBe("solow/task-finished");
  });

  it("records why the state changed, in a reason distinct from interrupted", async () => {
    // Both mean the run was lost; only one means the work survived it. An Owner reading the log
    // should be able to tell which happened to them.
    const db = createTestDb();
    const sessionId = await seedWithMarker(db, "task-recorded", "b");

    await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    const events = await db
      .select()
      .from(sessionEvent)
      .where(and(eq(sessionEvent.sessionId, sessionId), eq(sessionEvent.kind, "state")));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ to: "running", reason: RECOVERED_REASON });
  });

  it("announces the recovery, so the card gains its control without a reload", async () => {
    const db = createTestDb();
    await seedWithMarker(db, "task-announced", "b");
    const hub = fakeHub();

    await reclaimOrphanedRuns(db, fakeRegistry(), hub, LONG_AFTER);

    expect(hub.published.map((p) => p.channel)).toEqual([
      `board:${WS}`,
      `task:${WS}:task-announced`,
    ]);
    expect(hub.published[0]?.msg).toMatchObject({ kind: "status", state: "running" });
  });

  it("still fails a run that was lost with no evidence at all behind it", async () => {
    // The other half. No marker and no captured change means nothing to point at — and this is
    // the *only* case that is a failure, which is the whole change: an orphan used to be filed
    // as a failure whatever it had achieved.
    const db = createTestDb();
    await seedTask(db, { taskId: "task-midwork" });

    await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    const [row] = await db.select().from(task).where(eq(task.id, "task-midwork"));
    expect(row?.state).toBe("failed");
  });

  it("sends a run that produced a change back to ready, never to failed", async () => {
    // The case that buried real work: an agent edits a file, the orchestrator captures the diff
    // at a turn boundary, then the run is lost before the agent declares anything. The work is
    // on disk and described in the log; filing it as a failure is what made it invisible.
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-produced" });
    await db.insert(sessionEvent).values({
      id: "ev-diff-task-produced",
      workspaceId: WS,
      sessionId,
      seq: 0,
      kind: "diff",
      payload: {
        kind: "diff",
        diffRef: "solow/task-produced",
        files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
        patch: "",
        truncated: false,
      },
      at: new Date().toISOString(),
    });

    await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    const [row] = await db.select().from(task).where(eq(task.id, "task-produced"));
    expect(row?.state).toBe("ready");
    // And no failure reason left behind to make a recoverable Task look broken.
    expect(row?.failureReason).toBeNull();
  });
});

describe("reclaimOrphanedRuns when a previous sweep already closed the Session", () => {
  it("still reads the evidence, instead of filing the work as a failure", async () => {
    // The case that was sitting in a real database: a Task swept once into `failed`, moved back
    // to `running` from the board, and swept again — by which time its Session was closed, so a
    // lookup restricted to a live Session found nothing and failed it a second time.
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-reswept" });
    await db.insert(sessionEvent).values({
      id: "ev-diff-task-reswept",
      workspaceId: WS,
      sessionId,
      seq: 0,
      kind: "diff",
      payload: {
        kind: "diff",
        diffRef: "solow/task-reswept",
        files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0 }],
        patch: "",
        truncated: false,
      },
      at: new Date().toISOString(),
    });
    await db.update(session).set({ state: "closed" }).where(eq(session.id, sessionId));

    await reclaimOrphanedRuns(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    const [row] = await db.select().from(task).where(eq(task.id, "task-reswept"));
    expect(row?.state).toBe("ready");
    expect(row?.failureReason).toBeNull();
  });
});

describe("reportStrandedReviews", () => {
  it("leaves a Task that is simply waiting for a person", async () => {
    // The gate working is not a fault. Only a decision that was made and never took effect is.
    const db = createTestDb();
    await seedTask(db, { taskId: "task-waiting", taskState: "review" });

    const count = await reportStrandedReviews(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    expect(count).toBe(0);
    const [row] = await db.select().from(task).where(eq(task.id, "task-waiting"));
    expect(row?.failureReason).toBeNull();
  });

  it("names a decision that was recorded and never applied", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-stranded", taskState: "review" });
    await db.insert(review).values({
      id: "rev-stranded",
      workspaceId: WS,
      sessionId,
      decision: "approve",
      actorUserId: "u1",
    });

    const count = await reportStrandedReviews(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    expect(count).toBe(1);
    const [row] = await db.select().from(task).where(eq(task.id, "task-stranded"));
    // Still at the gate: the diff and the decision stay readable, and the reason says what broke.
    expect(row?.state).toBe("review");
    expect(row?.failureReason).toBe(STRANDED_REVIEW_REASON);
  });

  it("leaves a Task whose run is still registered", async () => {
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-live", taskState: "review" });
    await db.insert(review).values({
      id: "rev-live",
      workspaceId: WS,
      sessionId,
      decision: "approve",
      actorUserId: "u1",
    });

    const live = { get: () => ({}) } as unknown as Parameters<typeof reportStrandedReviews>[1];
    const count = await reportStrandedReviews(db, live, fakeHub(), LONG_AFTER);

    expect(count).toBe(0);
  });

  it("does not report the same Task twice", async () => {
    // The reason it writes is the reason it filters on, so a second sweep is a no-op.
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-once", taskState: "review" });
    await db.insert(review).values({
      id: "rev-once",
      workspaceId: WS,
      sessionId,
      decision: "approve",
      actorUserId: "u1",
    });

    await reportStrandedReviews(db, fakeRegistry(), fakeHub(), LONG_AFTER);
    const second = await reportStrandedReviews(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    expect(second).toBe(0);
  });
});

/**
 * The same failure one column over: a run that went missing while its Task read `parked`.
 *
 * Nothing watched for this before, and nothing else ever would have — `reclaimOrphanedRuns`
 * selects only `running` rows, and a sleeping run has no recorded decision for
 * `reportStrandedReviews` to find. The evidence is therefore the clock, so these cases are mostly
 * about the runs it must *not* touch: the one still inside its window, the one that woke and is
 * working, and the one that woke, finished and is waiting for a person with the Task row still
 * reading `parked`.
 */
describe("reportStrandedParks", () => {
  it("leaves a Task still sleeping out its quota window", async () => {
    // Twenty minutes into a five-hour sleep. A sweep that reported this would destroy work the
    // deployment is deliberately holding, and take the container out from under it.
    const db = createTestDb();
    await seedTask(db, { taskId: "task-sleeping", taskState: "parked" });

    const count = await reportStrandedParks(db, fakeRegistry(), fakeHub(), LONG_AFTER);

    expect(count).toBe(0);
    const [row] = await db.select().from(task).where(eq(task.id, "task-sleeping"));
    expect(row?.state).toBe("parked");
    expect(row?.failureReason).toBeNull();
  });

  it("names a park that slept through its own wake-up", async () => {
    const db = createTestDb();
    await seedTask(db, { taskId: "task-lost", taskState: "parked" });

    const count = await reportStrandedParks(db, fakeRegistry(), fakeHub(), AFTER_PARK_WINDOW);

    expect(count).toBe(1);
    const [row] = await db.select().from(task).where(eq(task.id, "task-lost"));
    // Still `parked`, like its review twin stays at the gate: the state is what happened to the
    // Task, and the reason is what happened to the run.
    expect(row?.state).toBe("parked");
    expect(row?.failureReason).toBe(STRANDED_PARK_REASON);
  });

  it("announces it to the board and to the Task's own page", async () => {
    const db = createTestDb();
    await seedTask(db, { taskId: "task-lost", taskState: "parked" });
    const hub = fakeHub();

    await reportStrandedParks(db, fakeRegistry(), hub, AFTER_PARK_WINDOW);

    expect(hub.published.map((p) => p.channel)).toEqual([`board:${WS}`, `task:${WS}:task-lost`]);
    expect(hub.published[0]?.msg).toMatchObject({ kind: "status", state: "parked" });
  });

  it("leaves a parked Task whose run woke up and is registered", async () => {
    // The park step moves the Task out of `running` and nothing moves it back, so a run that woke
    // and is mid-round is working with the row still reading `parked` and its Task's last write
    // hours old. The registry is the only thing that says so, which is why it is asked first.
    const db = createTestDb();
    await seedTask(db, { taskId: "task-woken", taskState: "parked" });
    const registry = fakeRegistry(new Set([`${WS}:task-woken`]));

    const count = await reportStrandedParks(db, registry, fakeHub(), AFTER_PARK_WINDOW);

    expect(count).toBe(0);
  });

  it("reads the Session's own log, not just the Task row", async () => {
    // The gap the registry leaves: between two durable steps of a woken round, nothing is
    // registered and the Task row has not been written since the park. What the run has been
    // doing is in its Session, and this is the half a sweep reading only `task.updatedAt` would
    // miss — it would condemn a run that spoke five minutes ago.
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-talking", taskState: "parked" });
    await db.insert(sessionEvent).values({
      id: "ev-woken",
      workspaceId: WS,
      sessionId,
      seq: 0,
      kind: "message",
      payload: { kind: "message", role: "assistant", text: "back from the quota window" },
      at: new Date(Date.now() + PARK_WINDOW_MS).toISOString(),
    });

    const count = await reportStrandedParks(db, fakeRegistry(), fakeHub(), AFTER_PARK_WINDOW);

    expect(count).toBe(0);
  });

  it("leaves a parked Task whose round finished and is waiting for a person", async () => {
    // A run that woke, worked and reached the gate sets its Session `awaiting_review` and then
    // waits in `waitForEvent` for up to seven days — silent, unregistered, and with the Task row
    // still reading `parked` until an operator opens the gate. Waiting for a person is never
    // stranded, which is the distinction `reportStrandedReviews` draws in the next column over.
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-at-gate", taskState: "parked" });
    await db.update(session).set({ state: "awaiting_review" }).where(eq(session.id, sessionId));

    const count = await reportStrandedParks(db, fakeRegistry(), fakeHub(), AFTER_PARK_WINDOW);

    expect(count).toBe(0);
    const [row] = await db.select().from(task).where(eq(task.id, "task-at-gate"));
    expect(row?.failureReason).toBeNull();
  });

  it("reports a parked Task whose wait for a person has itself run out", async () => {
    /*
     * The other end of the guard above, and until it was bounded there was no other end.
     *
     * A run lost at the review gate leaves the Session `awaiting_review` and the Task `parked`,
     * and nothing in the orchestrator can reach that pair: `reportStrandedReviews` selects
     * `task.state === "review"` and a parked round never moves the Task there, while `heldByRun`
     * reads `parked` with no reason as held, so the reaper keeps the container too. Three sweeps
     * at forty park windows out reported nothing and removed nothing — a permanent leak reachable
     * only through this feature's own path.
     *
     * Seven days is not a guess about lost runs; it is the gate's own `waitForEvent` timeout. Past
     * it either the run is gone or it woke, returned `review_timeout`, and left the Task exactly
     * as it is. Both are the sentence this reason exists to say.
     */
    const db = createTestDb();
    const { sessionId } = await seedTask(db, { taskId: "task-abandoned", taskState: "parked" });
    await db.update(session).set({ state: "awaiting_review" }).where(eq(session.id, sessionId));

    const count = await reportStrandedParks(db, fakeRegistry(), fakeHub(), AFTER_REVIEW_WAIT);

    expect(count).toBe(1);
    const [row] = await db.select().from(task).where(eq(task.id, "task-abandoned"));
    expect(row?.failureReason).toBe(STRANDED_PARK_REASON);
    expect(row?.state).toBe("parked");
  });

  it("measures the wait the review gate actually gives a person", async () => {
    /*
     * The second pinned copy in this file, and it fails in the direction that matters: this module
     * decides when a Session sitting at the gate has waited longer than the gate itself allows, so
     * a `REVIEW_WAIT_MS` smaller than the real timeout would condemn runs — and reap containers —
     * out from under reviewers who still have days to decide.
     *
     * The literal is parsed rather than restated, because the timeout `task-run.ts` hands Inngest
     * is a duration string and the drift would be in translating it.
     */
    const match = REVIEW_WAIT_TIMEOUT.match(/^(\d+)d$/);
    expect(match).not.toBeNull();
    expect(REVIEW_WAIT_MS).toBe(Number(match?.[1]) * 24 * 60 * 60 * 1000);
  });

  it("does not report the same Task twice", async () => {
    // The reason it writes is the reason it filters on, so a second sweep is a no-op — and the
    // stamp does not accumulate publishes on a board nobody has acted on yet.
    const db = createTestDb();
    await seedTask(db, { taskId: "task-once", taskState: "parked" });

    await reportStrandedParks(db, fakeRegistry(), fakeHub(), AFTER_PARK_WINDOW);
    const second = await reportStrandedParks(db, fakeRegistry(), fakeHub(), AFTER_PARK_WINDOW);

    expect(second).toBe(0);
  });

  it("measures the window the park step actually sleeps for", async () => {
    /*
     * The one assertion in this file that is not about a row.
     *
     * `PARK_WINDOW_MS` is a second copy of `PARK_SLEEP_MS`, kept here because a sweep that runs
     * every sixty seconds must not import the durable workflow module and everything it drags in
     * — and a comment saying "change one, change both" is not a mechanism. The drift that matters
     * has a direction: grow the sleep without growing this and every run still legitimately asleep
     * starts being reported, and its container reaped, hours before its own wake-up time.
     *
     * Deliberately an equality rather than a `>=`. This module is allowed to wait *longer* than a
     * park (it already adds `RECLAIM_STALE_MS` at the call site), but a copy that is merely
     * "enough" today drifts silently; a copy that must be exact cannot.
     */
    expect(PARK_WINDOW_MS).toBe(PARK_SLEEP_MS);
  });
});
