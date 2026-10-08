/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { ReviewDecision, TaskState } from "@solow/contracts";
import { MODEL_PRICES } from "@solow/core";
import {
  harnessCatalog,
  harnessProfile,
  review,
  session,
  sessionUsage,
  task,
  taskRepository,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { outcomesWindowStart, workspaceOutcomes } from "./outcomes.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Outcomes against a real SQLite database. Each fixture is a Task with the rows the product
 * would have written on its way to that state — Sessions, review decisions, attachments with or
 * without a result branch and a pull request — so the SQL is tested against the shapes it will
 * meet, including the ones that must *not* count.
 */

const NOW = new Date("2026-10-08T12:00:00.000Z"); // a Thursday
const WEEKS = 4; // 2026-09-14 … 2026-10-05

let db: TestDb;
let graph: Awaited<ReturnType<typeof seedWorkspaceGraph>>;
let issueId: string;
let counter = 0;

beforeEach(async () => {
  db = createTestDb();
  graph = await seedWorkspaceGraph(db, "acme");
  await db
    .update(workspace)
    .set({ createdAt: "2026-09-01T09:00:00.000Z" })
    .where(eq(workspace.id, graph.workspaceId));
  issueId = (await seedIssue(db, graph.workspaceId)).id;
});

interface Round {
  decision: ReviewDecision;
  at: string;
}

/** A Task, one Session started at `runAt`, its review decisions and its one attachment. */
async function seedTask(opts: {
  title: string;
  state: TaskState;
  runAt?: string;
  rounds?: Round[];
  committed?: boolean;
  pullRequest?: boolean;
  failureReason?: string;
  deletedAt?: string;
  workspaceId?: string;
  profileId?: string;
}) {
  const ws = opts.workspaceId ?? graph.workspaceId;
  const [row] = await db
    .insert(task)
    .values({
      workspaceId: ws,
      issueId,
      title: opts.title,
      state: opts.state,
      agentProfileId: opts.profileId ?? graph.agentProfileId,
      executorProfileId: graph.executorProfileId,
      failureReason: opts.failureReason ?? null,
      deletedAt: opts.deletedAt ?? null,
    })
    .returning();
  if (!row) throw new Error("seed task");
  counter += 1;
  await db.insert(taskRepository).values({
    workspaceId: ws,
    taskId: row.id,
    repositoryId: graph.repositoryId,
    checkoutBranch: `solow/task-${counter}`,
    resultBranch: opts.committed ? `solow/task-${counter}` : null,
    changeRequestUrl: opts.pullRequest ? `https://example.test/pr/${counter}` : null,
    changeRequestNumber: opts.pullRequest ? counter : null,
  });
  let sessionId: string | null = null;
  if (opts.runAt) {
    const [s] = await db
      .insert(session)
      .values({ workspaceId: ws, taskId: row.id, startedAt: opts.runAt })
      .returning();
    sessionId = s?.id ?? null;
    for (const round of opts.rounds ?? []) {
      await db.insert(review).values({
        workspaceId: ws,
        sessionId: sessionId ?? "",
        decision: round.decision,
        actorUserId: "user-1",
        createdAt: round.at,
      });
    }
  }
  return { taskId: row.id, sessionId };
}

async function seedUsage(
  at: { taskId: string; sessionId: string | null },
  turns: Array<{
    model: string | null;
    input?: number;
    output?: number;
    reported?: boolean;
    profileId?: string;
    at?: string;
  }>,
) {
  let seq = 0;
  for (const turn of turns) {
    seq += 1;
    await db.insert(sessionUsage).values({
      workspaceId: graph.workspaceId,
      sessionId: at.sessionId ?? "",
      taskId: at.taskId,
      agentProfileId: turn.profileId ?? graph.agentProfileId,
      messageId: `msg-${counter}-${seq}`,
      seq,
      model: turn.model,
      inputTokens: turn.input ?? 0,
      outputTokens: turn.output ?? 0,
      reported: turn.reported ?? true,
      at: turn.at ?? "2026-10-06T10:00:00.000Z",
    });
  }
}

async function seedSubscriptionProfile(): Promise<string> {
  const [catalog] = await db
    .select({ id: harnessCatalog.id })
    .from(harnessCatalog)
    .where(eq(harnessCatalog.workspaceId, graph.workspaceId));
  const [row] = await db
    .insert(harnessProfile)
    .values({
      workspaceId: graph.workspaceId,
      name: "claude-max",
      agentCatalogId: catalog?.id ?? "",
      authMode: "subscription",
      secretId: "secret-2",
    })
    .returning();
  return row?.id ?? "";
}

async function read() {
  const result = await workspaceOutcomes(ctxFor(db, graph.workspaceId), { weeks: WEEKS }, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("outcomesWindowStart", () => {
  it("starts on the Monday of the current week, UTC, and steps back whole weeks", () => {
    expect(outcomesWindowStart(NOW, 1).toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(outcomesWindowStart(NOW, 4).toISOString()).toBe("2026-09-14T00:00:00.000Z");
    // A Sunday belongs to the week that started six days earlier, a Monday to its own.
    expect(outcomesWindowStart(new Date("2026-10-11T23:59:00Z"), 1).toISOString()).toBe(
      "2026-10-05T00:00:00.000Z",
    );
    expect(outcomesWindowStart(new Date("2026-10-05T00:00:00Z"), 1).toISOString()).toBe(
      "2026-10-05T00:00:00.000Z",
    );
  });
});

describe("workspaceOutcomes — empty", () => {
  it("returns zeros and nulls, never a rate over nothing", async () => {
    const data = await read();
    expect(data.window.from).toBe("2026-09-14T00:00:00.000Z");
    expect(data.shipped.total).toBe(0);
    expect(data.shipped.weeks.map((w) => w.weekStart)).toEqual([
      "2026-09-14",
      "2026-09-21",
      "2026-09-28",
      "2026-10-05",
    ]);
    expect(data.approval.runTasks).toBe(0);
    expect(data.approval.approvalRate).toBeNull();
    expect(data.approval.withinTwoRate).toBeNull();
    expect(data.approval.meanAttempts).toBeNull();
    expect(data.spend.total.turns).toBe(0);
    expect(data.spend.byProfile).toEqual([]);
    expect(data.firstPullRequest).toEqual({
      workspaceCreatedAt: "2026-09-01T09:00:00.000Z",
      shippedAt: null,
      elapsedMs: null,
    });
  });
});

describe("workspaceOutcomes — shipped", () => {
  it("counts approved-and-committed Done Tasks per week of the latest approval, split by PR", async () => {
    await seedTask({
      title: "pr",
      state: "done",
      runAt: "2026-09-15T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-09-16T10:00:00.000Z" }],
      committed: true,
      pullRequest: true,
    });
    // Keep local: approved, committed, no request.
    await seedTask({
      title: "kept local",
      state: "done",
      runAt: "2026-10-05T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-10-06T10:00:00.000Z" }],
      committed: true,
    });
    // Redelivered: Ship again moved it failed → done; the approval dates it.
    await seedTask({
      title: "redelivered",
      state: "done",
      runAt: "2026-10-05T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-10-07T10:00:00.000Z" }],
      committed: true,
      pullRequest: true,
    });

    const data = await read();
    expect(data.shipped.total).toBe(3);
    expect(data.shipped.asPullRequest).toBe(2);
    expect(data.shipped.localCommit).toBe(1);
    expect(data.shipped.weeks).toEqual([
      { weekStart: "2026-09-14", shipped: 1, asPullRequest: 1 },
      { weekStart: "2026-09-21", shipped: 0, asPullRequest: 0 },
      { weekStart: "2026-09-28", shipped: 0, asPullRequest: 0 },
      { weekStart: "2026-10-05", shipped: 2, asPullRequest: 1 },
    ]);
  });

  it("does not count a Task moved to Done on the board without an approval", async () => {
    await seedTask({
      title: "dragged",
      state: "done",
      runAt: "2026-10-05T09:00:00.000Z",
      rounds: [],
      committed: false,
    });
    const data = await read();
    expect(data.shipped.total).toBe(0);
    expect(data.approval.approved).toBe(0);
  });

  it("counts a delivery that failed as approved, not shipped", async () => {
    await seedTask({
      title: "push refused",
      state: "failed",
      failureReason: "delivery_failed",
      runAt: "2026-10-05T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-10-06T10:00:00.000Z" }],
      committed: true,
    });
    await seedTask({
      title: "half landed",
      state: "failed",
      failureReason: "partial_integration",
      runAt: "2026-10-05T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-10-06T11:00:00.000Z" }],
      committed: true,
    });
    const data = await read();
    expect(data.shipped.total).toBe(0);
    expect(data.shipped.approvedNotDelivered).toBe(2);
    expect(data.approval.approved).toBe(2);
  });

  it("counts a re-approved Task once, in the week of its latest approval", async () => {
    await seedTask({
      title: "reopened and approved again",
      state: "done",
      runAt: "2026-09-15T09:00:00.000Z",
      rounds: [
        { decision: "approve", at: "2026-09-16T10:00:00.000Z" },
        { decision: "request_changes", at: "2026-10-05T10:00:00.000Z" },
        { decision: "approve", at: "2026-10-06T10:00:00.000Z" },
      ],
      committed: true,
      pullRequest: true,
    });
    const data = await read();
    expect(data.shipped.total).toBe(1);
    expect(data.shipped.weeks.map((w) => w.shipped)).toEqual([0, 0, 0, 1]);
    // One send-back before the latest approval.
    expect(data.approval.meanAttempts).toBe(2);
  });

  it("leaves out a Task reopened and not yet done again", async () => {
    await seedTask({
      title: "reopened",
      state: "running",
      runAt: "2026-09-15T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-09-16T10:00:00.000Z" }],
      committed: true,
      pullRequest: true,
    });
    const data = await read();
    expect(data.shipped.total).toBe(0);
    // It *was* approved, so it is settled, not in flight.
    expect(data.approval.approved).toBe(1);
    expect(data.approval.inFlight).toBe(0);
  });

  it("leaves out deleted Tasks and Tasks approved before the window", async () => {
    await seedTask({
      title: "deleted",
      state: "done",
      runAt: "2026-10-05T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-10-06T10:00:00.000Z" }],
      committed: true,
      pullRequest: true,
      deletedAt: "2026-10-07T00:00:00.000Z",
    });
    await seedTask({
      title: "old",
      state: "done",
      runAt: "2026-09-01T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-09-02T10:00:00.000Z" }],
      committed: true,
      pullRequest: true,
    });
    const data = await read();
    expect(data.shipped.total).toBe(0);
    expect(data.approval.runTasks).toBe(0);
    // The old one is still the first pull request, which is all-time.
    expect(data.firstPullRequest.shippedAt).toBe("2026-09-02T10:00:00.000Z");
    expect(data.firstPullRequest.elapsedMs).toBe(
      Date.parse("2026-09-02T10:00:00.000Z") - Date.parse("2026-09-01T09:00:00.000Z"),
    );
  });

  it("never reads another Workspace's Tasks", async () => {
    const other = await seedWorkspaceGraph(db, "globex");
    const otherIssue = await seedIssue(db, other.workspaceId);
    issueId = otherIssue.id;
    await seedTask({
      title: "theirs",
      state: "done",
      runAt: "2026-10-05T09:00:00.000Z",
      rounds: [{ decision: "approve", at: "2026-10-06T10:00:00.000Z" }],
      committed: true,
      pullRequest: true,
      workspaceId: other.workspaceId,
      profileId: other.agentProfileId,
    });
    const data = await read();
    expect(data.shipped.total).toBe(0);
    expect(data.approval.runTasks).toBe(0);
    expect(data.firstPullRequest.shippedAt).toBeNull();
  });
});

describe("workspaceOutcomes — approval and attempts", () => {
  it("rates settled run Tasks, leaves in-flight ones out, and buckets attempts", async () => {
    const run = "2026-10-05T09:00:00.000Z";
    const at = (h: number) => `2026-10-06T${String(h).padStart(2, "0")}:00:00.000Z`;
    // First time.
    await seedTask({
      title: "one",
      state: "done",
      runAt: run,
      rounds: [{ decision: "approve", at: at(1) }],
      committed: true,
    });
    // Second attempt, after a request for changes.
    await seedTask({
      title: "two",
      state: "done",
      runAt: run,
      rounds: [
        { decision: "request_changes", at: at(1) },
        { decision: "approve", at: at(2) },
      ],
      committed: true,
    });
    // Four rounds: reject, relaunch, two requests for changes, then approve.
    await seedTask({
      title: "four",
      state: "done",
      runAt: run,
      rounds: [
        { decision: "reject", at: at(1) },
        { decision: "request_changes", at: at(2) },
        { decision: "request_changes", at: at(3) },
        { decision: "approve", at: at(4) },
      ],
      committed: true,
    });
    // A Workflow approved first time at each of two gates: intermediate approvals are not rounds.
    await seedTask({
      title: "workflow",
      state: "done",
      runAt: run,
      rounds: [
        { decision: "approve", at: at(1) },
        { decision: "approve", at: at(2) },
      ],
      committed: true,
    });
    // Rejected and left: settled, not approved.
    await seedTask({
      title: "rejected",
      state: "ready",
      runAt: run,
      rounds: [{ decision: "reject", at: at(1) }],
    });
    // Parked on quota and waiting at the gate: in flight, not counted against the rate.
    await seedTask({ title: "parked", state: "parked", runAt: run });
    await seedTask({ title: "at the gate", state: "review", runAt: run });
    // Never run: not a run Task at all.
    await seedTask({ title: "backlog", state: "backlog" });
    // Run before the window: outside the cohort.
    await seedTask({
      title: "earlier",
      state: "failed",
      runAt: "2026-09-01T09:00:00.000Z",
    });

    const { approval } = await read();
    expect(approval.runTasks).toBe(7);
    expect(approval.inFlight).toBe(2);
    expect(approval.settled).toBe(5);
    expect(approval.approved).toBe(4);
    expect(approval.approvedWithinTwo).toBe(3);
    expect(approval.approvalRate).toBeCloseTo(4 / 5);
    expect(approval.withinTwoRate).toBeCloseTo(3 / 5);
    expect(approval.meanAttempts).toBeCloseTo((1 + 2 + 4 + 1) / 4);
    expect(approval.attempts).toEqual([
      { attempts: 1, orMore: false, tasks: 2 },
      { attempts: 2, orMore: false, tasks: 1 },
      { attempts: 3, orMore: false, tasks: 0 },
      { attempts: 4, orMore: true, tasks: 1 },
    ]);
  });
});

describe("workspaceOutcomes — spend", () => {
  it("sums tokens per Task, Profile and billing mode, pricing only known API-key models", async () => {
    const priced = Object.keys(MODEL_PRICES)[0] ?? "";
    const price = MODEL_PRICES[priced];
    const subscription = await seedSubscriptionProfile();
    const a = await seedTask({
      title: "metered",
      state: "done",
      runAt: "2026-10-05T09:00:00.000Z",
    });
    await seedUsage(a, [
      { model: priced, input: 1_000_000, output: 100_000 },
      { model: "some-future-model", input: 500, output: 50 },
      { model: null, reported: false },
    ]);
    const b = await seedTask({
      title: "subscription",
      state: "running",
      runAt: "2026-10-05T09:00:00.000Z",
      profileId: subscription,
    });
    await seedUsage(b, [{ model: priced, input: 10, output: 20, profileId: subscription }]);
    // Before the window, and on a deleted Task: neither counts.
    await seedUsage(a, [{ model: priced, input: 999, at: "2026-09-01T00:00:00.000Z" }]);
    const gone = await seedTask({
      title: "deleted",
      state: "failed",
      runAt: "2026-10-05T09:00:00.000Z",
      deletedAt: "2026-10-07T00:00:00.000Z",
    });
    await seedUsage(gone, [{ model: priced, input: 777 }]);

    const { spend } = await read();
    const expectedCost = ((price?.input ?? 0) * 1_000_000 + (price?.output ?? 0) * 100_000) / 1e6;

    expect(spend.tasks).toBe(2);
    expect(spend.total.turns).toBe(4);
    expect(spend.total.unreportedTurns).toBe(1);
    expect(spend.total.inputTokens).toBe(1_000_000 + 500 + 10);
    expect(spend.total.meteredTurns).toBe(2);
    expect(spend.total.unpricedTurns).toBe(1);
    expect(spend.total.meteredCostUsd).toBeCloseTo(expectedCost);

    const modes = Object.fromEntries(spend.byBillingMode.map((m) => [m.authMode, m]));
    expect(modes.subscription?.turns).toBe(1);
    expect(modes.subscription?.meteredTurns).toBe(0);
    expect(modes.subscription?.meteredCostUsd).toBe(0);
    expect(modes.api_key?.turns).toBe(3);

    expect(spend.byProfile.map((p) => [p.name, p.authMode, p.tasks])).toEqual([
      ["claude", "api_key", 1],
      ["claude-max", "subscription", 1],
    ]);
    expect(spend.topTasks.map((t) => t.title)).toEqual(["metered", "subscription"]);
    expect(spend.topTasks[0]?.meteredCostUsd).toBeCloseTo(expectedCost);
  });
});
