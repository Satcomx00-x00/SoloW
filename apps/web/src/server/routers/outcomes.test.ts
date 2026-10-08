/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { outcomesDto } from "@solow/contracts";
import { type FlagKey, review, session, task, taskRepository } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { seedIssue, seedWorkspaceGraph } from "../dal/test-fixtures.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * `outcomes.get` through the router: the parts the DAL test cannot see — the session, both kill
 * switches, the input bounds, and the tenant coming from the session rather than the input.
 */

let db: TestDb;
let acme: Awaited<ReturnType<typeof seedWorkspaceGraph>>;
let globex: Awaited<ReturnType<typeof seedWorkspaceGraph>>;

function caller(workspaceId: string | null, flags: Partial<Record<FlagKey, boolean>> = {}) {
  const ctx: BaseContext = {
    db,
    session: workspaceId ? { workspaceId, userId: "user-1" } : null,
    flagOverrides: { "ff-core-program": true, "ff-outcomes": true, ...flags },
  };
  return appRouter.createCaller(ctx);
}

async function errCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

/** A Task shipped as a pull request a moment ago: approved, committed, request opened. */
async function seedShipped(graph: typeof acme) {
  const issue = await seedIssue(db, graph.workspaceId);
  const [row] = await db
    .insert(task)
    .values({
      workspaceId: graph.workspaceId,
      issueId: issue.id,
      title: "shipped",
      state: "done",
      agentProfileId: graph.agentProfileId,
      executorProfileId: graph.executorProfileId,
    })
    .returning();
  const [s] = await db
    .insert(session)
    .values({ workspaceId: graph.workspaceId, taskId: row?.id ?? "" })
    .returning();
  await db.insert(review).values({
    workspaceId: graph.workspaceId,
    sessionId: s?.id ?? "",
    decision: "approve",
    actorUserId: "user-1",
  });
  await db.insert(taskRepository).values({
    workspaceId: graph.workspaceId,
    taskId: row?.id ?? "",
    repositoryId: graph.repositoryId,
    checkoutBranch: "solow/shipped",
    resultBranch: "solow/shipped",
    changeRequestUrl: "https://example.test/pr/1",
    changeRequestNumber: 1,
  });
}

beforeEach(async () => {
  db = createTestDb();
  acme = await seedWorkspaceGraph(db, "acme");
  globex = await seedWorkspaceGraph(db, "globex");
});

describe("outcomes.get", () => {
  it("refuses a caller with no session", async () => {
    expect(await errCode(() => caller(null).outcomes.get({}))).toBe("UNAUTHORIZED");
  });

  it("is off when either its own switch or the core loop's is off", async () => {
    expect(
      await errCode(() => caller(acme.workspaceId, { "ff-outcomes": false }).outcomes.get({})),
    ).toBe("FORBIDDEN");
    expect(
      await errCode(() => caller(acme.workspaceId, { "ff-core-program": false }).outcomes.get({})),
    ).toBe("FORBIDDEN");
  });

  it("refuses a window outside 1 to 104 weeks", async () => {
    expect(await errCode(() => caller(acme.workspaceId).outcomes.get({ weeks: 0 }))).toBe(
      "BAD_REQUEST",
    );
    expect(await errCode(() => caller(acme.workspaceId).outcomes.get({ weeks: 105 }))).toBe(
      "BAD_REQUEST",
    );
  });

  it("defaults to twelve weeks and reports the session's Workspace only", async () => {
    await seedShipped(globex);
    await seedShipped(acme);
    await seedShipped(globex);

    const mine = await caller(acme.workspaceId).outcomes.get({});
    expect(outcomesDto.safeParse(mine).success).toBe(true);
    expect(mine.window.weeks).toBe(12);
    expect(mine.shipped.weeks).toHaveLength(12);
    expect(mine.shipped.total).toBe(1);
    expect(mine.shipped.asPullRequest).toBe(1);
    expect(mine.approval.approvalRate).toBe(1);

    const theirs = await caller(globex.workspaceId).outcomes.get({ weeks: 4 });
    expect(theirs.shipped.total).toBe(2);
    expect(theirs.shipped.weeks).toHaveLength(4);
  });
});
