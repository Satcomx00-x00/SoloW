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
  session as sessionTable,
  taskRepository,
  task as taskTable,
  workspace,
} from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The change a reviewer is shown, grouped per Repository (issue #7 AC-4).
 *
 * The orchestrator writes one `diff` event per worktree; this is the read side of that — what
 * `session.get` makes of a log holding several, and what it makes of one written before
 * multi-repository Tasks existed.
 */

function ctx(db: TestDb, workspaceId: string): BaseContext {
  return {
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: { "ff-core-program": true },
  };
}

const caller = (db: TestDb, workspaceId: string) => appRouter.createCaller(ctx(db, workspaceId));

/** A Workspace with one Task and one live Session to hang diff events off. */
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
  const [repoA] = await db
    .insert(repository)
    .values({ workspaceId: ws.id, name: "api", source: "local_path", location: "/srv/api" })
    .returning();
  const [repoB] = await db
    .insert(repository)
    .values({ workspaceId: ws.id, name: "shared-lib", source: "local_path", location: "/srv/lib" })
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
      title: "Cross-repository change",
      state: "review",
      agentProfileId: agent?.id ?? "",
      executorProfileId: executor?.id ?? "",
    })
    .returning();
  if (!task || !repoA || !repoB) throw new Error("failed to seed task");
  await db.insert(taskRepository).values([
    {
      workspaceId: ws.id,
      taskId: task.id,
      repositoryId: repoA.id,
      checkoutBranch: `gatecontrol/task-${task.id}`,
      position: 0,
    },
    {
      workspaceId: ws.id,
      taskId: task.id,
      repositoryId: repoB.id,
      checkoutBranch: "feature/lib",
      position: 1,
    },
  ]);
  const [session] = await db
    .insert(sessionTable)
    .values({ workspaceId: ws.id, taskId: task.id, state: "awaiting_review" })
    .returning();
  if (!session) throw new Error("failed to seed session");
  return { workspaceId: ws.id, sessionId: session.id, repoA: repoA.id, repoB: repoB.id };
}

/** Append a `diff` event exactly as the orchestrator's review gate writes one. */
async function appendDiff(
  db: TestDb,
  fx: { workspaceId: string; sessionId: string },
  seq: number,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(sessionEvent).values({
    workspaceId: fx.workspaceId,
    sessionId: fx.sessionId,
    seq,
    kind: "diff",
    payload,
  });
}

const change = (path: string) => ({
  files: [{ path, status: "modified" as const, additions: 1, deletions: 0 }],
  patch: `--- a/${path}\n+++ b/${path}\n`,
  truncated: false,
});

describe("session.get — the diff a reviewer is shown", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns one entry per Repository, in attachment order", async () => {
    const fx = await fixture(db);
    await appendDiff(db, fx, 0, {
      diffRef: "gatecontrol/task-1",
      repositoryId: fx.repoA,
      repositoryName: "api",
      ...change("src/api.ts"),
    });
    await appendDiff(db, fx, 1, {
      diffRef: "feature/lib",
      repositoryId: fx.repoB,
      repositoryName: "shared-lib",
      ...change("src/lib.ts"),
    });

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });

    expect(detail.diffs.map((d) => d.repositoryName)).toEqual(["api", "shared-lib"]);
    expect(detail.diffs.map((d) => d.files[0]?.path)).toEqual(["src/api.ts", "src/lib.ts"]);
    // `diff` still answers "the change", so a single-Repository consumer needs no change.
    expect(detail.diff?.repositoryName).toBe("api");
  });

  it("keeps the latest round per Repository, not a second group for the same one", async () => {
    // A request_changes round re-captures every worktree. Appending rather than replacing would
    // show a reviewer the same repository twice, once stale.
    const fx = await fixture(db);
    await appendDiff(db, fx, 0, {
      diffRef: "gatecontrol/task-1",
      repositoryId: fx.repoA,
      repositoryName: "api",
      ...change("src/first-round.ts"),
    });
    await appendDiff(db, fx, 1, {
      diffRef: "gatecontrol/task-1",
      repositoryId: fx.repoA,
      repositoryName: "api",
      ...change("src/second-round.ts"),
    });

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });

    expect(detail.diffs).toHaveLength(1);
    expect(detail.diffs[0]?.files[0]?.path).toBe("src/second-round.ts");
  });

  it("still shows a diff captured before Repositories were named on the event", async () => {
    // The payload column is untyped JSON and the log is append-only, so an event written by an
    // older build has to keep parsing — otherwise every finished Task's Changes tab goes blank.
    const fx = await fixture(db);
    await appendDiff(db, fx, 0, { diffRef: "gatecontrol/task-1", ...change("src/legacy.ts") });

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });

    expect(detail.diffs).toHaveLength(1);
    expect(detail.diffs[0]?.repositoryName).toBeUndefined();
    expect(detail.diffs[0]?.files[0]?.path).toBe("src/legacy.ts");
  });

  it("puts the primary Repository first even when a secondary was captured first", async () => {
    // Each capture is wrapped in its own try/catch so one repository failing costs only its own
    // group — which means the log's order is capture order, not attachment order. A round where
    // the primary's capture threw and a secondary's succeeded would otherwise make `diff`, which
    // every legacy consumer reads as "the primary Repository's change", a secondary's change.
    const fx = await fixture(db);
    await appendDiff(db, fx, 0, {
      diffRef: "feature/lib",
      repositoryId: fx.repoB,
      repositoryName: "shared-lib",
      ...change("src/lib.ts"),
    });
    await appendDiff(db, fx, 1, {
      diffRef: "gatecontrol/task-1",
      repositoryId: fx.repoA,
      repositoryName: "api",
      ...change("src/api.ts"),
    });

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });

    expect(detail.diffs.map((d) => d.repositoryName)).toEqual(["api", "shared-lib"]);
    expect(detail.diff?.repositoryName).toBe("api");
  });

  it("drops a diff captured before Repositories were named once a later round named one", async () => {
    // A Task sitting at the review gate across an orchestrator upgrade: the memoized capture from
    // the round before it has no repository, the round after it does. Showing both would give a
    // single-Repository Task a second, superseded "Unnamed repository" group — and `diff`, taken
    // from the head of the list, would be the stale one.
    const fx = await fixture(db);
    await appendDiff(db, fx, 0, { diffRef: "gatecontrol/task-1", ...change("src/old-stale.ts") });
    await appendDiff(db, fx, 1, {
      diffRef: "gatecontrol/task-1",
      repositoryId: fx.repoA,
      repositoryName: "api",
      ...change("src/current.ts"),
    });

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });

    expect(detail.diffs).toHaveLength(1);
    expect(detail.diffs[0]?.repositoryName).toBe("api");
    expect(detail.diff?.files[0]?.path).toBe("src/current.ts");
  });

  it("has no diffs at all before the agent reaches the review gate", async () => {
    const fx = await fixture(db);

    const detail = await caller(db, fx.workspaceId).session.get({ sessionId: fx.sessionId });

    expect(detail.diffs).toEqual([]);
    expect(detail.diff).toBeNull();
  });
});
