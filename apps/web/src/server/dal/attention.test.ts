/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { TaskState } from "@solow/contracts";
import {
  INTERRUPTED_REASON,
  PARK_WINDOW_MS,
  QUIET_RUN_MS,
  RECLAIM_STALE_MS,
  STRANDED_PARK_REASON,
  STRANDED_REVIEW_REASON,
} from "@solow/core";
import { session, sessionEvent, task } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { listRunsNeedingAttention } from "./attention.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const clock = () => new Date(NOW);
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let db: TestDb;
let acme: string;
let profiles: { agentProfileId: string; executorProfileId: string };

beforeEach(async () => {
  db = createTestDb();
  const graph = await seedWorkspaceGraph(db, "acme");
  acme = graph.workspaceId;
  profiles = { agentProfileId: graph.agentProfileId, executorProfileId: graph.executorProfileId };
});

async function seedTask(
  title: string,
  state: TaskState,
  opts: {
    failureReason?: string;
    updatedAt?: string;
    workspaceId?: string;
    deleted?: boolean;
  } = {},
): Promise<string> {
  const workspaceId = opts.workspaceId ?? acme;
  const issue = await seedIssue(db, workspaceId, { title: `Issue for ${title}` });
  const [row] = await db
    .insert(task)
    .values({
      workspaceId,
      issueId: issue.id,
      title,
      state,
      failureReason: opts.failureReason ?? null,
      updatedAt: opts.updatedAt ?? ago(60_000),
      deletedAt: opts.deleted ? ago(1_000) : null,
      ...profiles,
    })
    .returning();
  if (!row) throw new Error("failed to seed task");
  return row.id;
}

/** A Session for the Task, with one event at `lastAt` when given. */
async function seedRun(
  taskId: string,
  opts: { startedAt: string; lastAt?: string; state?: "active" | "awaiting_review" },
) {
  const [run] = await db
    .insert(session)
    .values({ workspaceId: acme, taskId, state: opts.state ?? "active", startedAt: opts.startedAt })
    .returning();
  if (!run) throw new Error("failed to seed session");
  if (opts.lastAt) {
    await db.insert(sessionEvent).values({
      workspaceId: acme,
      sessionId: run.id,
      seq: 0,
      kind: "stdout",
      payload: { kind: "stdout", text: "working", channel: "assistant" },
      at: opts.lastAt,
    });
  }
}

const listed = async () => {
  const result = await listRunsNeedingAttention(ctxFor(db, acme), clock);
  if (!result.ok) throw new Error(result.error);
  return result.data;
};

describe("listRunsNeedingAttention", () => {
  it("is empty for a Workspace where every run is moving or waiting on purpose", async () => {
    await seedTask("Backlog", "backlog");
    await seedTask("Waiting for review", "review");
    const running = await seedTask("Busy", "running", { updatedAt: ago(QUIET_RUN_MS * 3) });
    await seedRun(running, { startedAt: ago(QUIET_RUN_MS * 3), lastAt: ago(30_000) });

    expect((await listed()).items).toEqual([]);
  });

  it("lists failed Tasks with their reason", async () => {
    const id = await seedTask("Broke", "failed", {
      failureReason: INTERRUPTED_REASON,
      updatedAt: ago(5_000),
    });

    expect((await listed()).items).toEqual([
      {
        taskId: id,
        title: "Broke",
        state: "failed",
        failureReason: INTERRUPTED_REASON,
        kind: "failed",
        cause: "failed",
        since: ago(5_000),
      },
    ]);
  });

  it("names each kind of stuck run from the rows the sweep writes", async () => {
    const decision = await seedTask("Decided", "review", { failureReason: STRANDED_REVIEW_REASON });
    const park = await seedTask("Slept through", "parked", {
      failureReason: STRANDED_PARK_REASON,
      updatedAt: ago(PARK_WINDOW_MS * 2),
    });
    const silent = await seedTask("Quiet", "running", { updatedAt: ago(QUIET_RUN_MS * 2) });
    await seedRun(silent, { startedAt: ago(QUIET_RUN_MS * 2), lastAt: ago(QUIET_RUN_MS + 1_000) });

    const causes = Object.fromEntries((await listed()).items.map((i) => [i.taskId, i.cause]));
    expect(causes).toEqual({
      [decision]: "decision_not_applied",
      [park]: "park_never_resumed",
      [silent]: "run_silent",
    });
  });

  it("reads silence from the newest event, not from when the run started", async () => {
    const id = await seedTask("Long run", "running", { updatedAt: ago(PARK_WINDOW_MS) });
    await seedRun(id, { startedAt: ago(PARK_WINDOW_MS), lastAt: ago(QUIET_RUN_MS - 60_000) });

    const list = await listed();
    expect(list.items).toEqual([]);
    // And it says when to look again: the moment that last word is a whole quiet window old.
    expect(list.recheckAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it("falls back to the Session's start for a run that never said anything", async () => {
    const id = await seedTask("Hung at launch", "running", { updatedAt: ago(QUIET_RUN_MS * 2) });
    await seedRun(id, { startedAt: ago(QUIET_RUN_MS) });

    expect((await listed()).items.map((i) => i.cause)).toEqual(["run_silent"]);
  });

  it("leaves out a finished run whose Task still reads running", async () => {
    const id = await seedTask("Done, unopened", "running", { updatedAt: ago(QUIET_RUN_MS * 5) });
    await seedRun(id, { startedAt: ago(QUIET_RUN_MS * 5), state: "awaiting_review" });

    expect((await listed()).items).toEqual([]);
  });

  it("flags a park past its wake-up before the orchestrator has stamped it", async () => {
    const overdue = ago(PARK_WINDOW_MS + RECLAIM_STALE_MS);
    const id = await seedTask("Overslept", "parked", { updatedAt: overdue });
    await seedRun(id, { startedAt: overdue, lastAt: overdue });

    expect((await listed()).items.map((i) => [i.taskId, i.cause])).toEqual([[id, "park_overdue"]]);
  });

  it("leaves out deleted Tasks and other Workspaces' Tasks", async () => {
    await seedTask("In History", "failed", { deleted: true });
    const other = await seedWorkspaceGraph(db, "other");
    await seedTask("Not ours", "failed", { workspaceId: other.workspaceId });

    expect((await listed()).items).toEqual([]);
  });

  it("puts the newest first", async () => {
    await seedTask("Older", "failed", { updatedAt: ago(60 * 60_000) });
    await seedTask("Newer", "failed", { updatedAt: ago(60_000) });

    expect((await listed()).items.map((i) => i.title)).toEqual(["Newer", "Older"]);
  });
});
