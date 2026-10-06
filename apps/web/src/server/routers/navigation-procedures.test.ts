/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { task } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { seedIssue, seedWorkspaceGraph } from "../dal/test-fixtures.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The two reads the sidebar is built on — `workspace.counts` and `task.recent` — through the real
 * router: the session check, the tenancy that comes from it (Principle V), and the shapes the
 * client reads. The DAL tests cover the counting; these cover who may ask and what they get.
 */

let db: TestDb;
let acme: { workspaceId: string; agentProfileId: string; executorProfileId: string };
let globex: { workspaceId: string };

function caller(session: { workspaceId: string; userId: string } | null) {
  const ctx: BaseContext = { db, session, flagOverrides: { "ff-core-program": true } };
  return appRouter.createCaller(ctx);
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
}

async function seedTask(workspaceId: string, title: string): Promise<string> {
  const issue = await seedIssue(db, workspaceId, { title: `Issue for ${title}` });
  const [row] = await db
    .insert(task)
    .values({
      workspaceId,
      issueId: issue.id,
      title,
      state: "review",
      agentProfileId: acme.agentProfileId,
      executorProfileId: acme.executorProfileId,
    })
    .returning();
  return row?.id ?? "";
}

beforeEach(async () => {
  db = createTestDb();
  acme = await seedWorkspaceGraph(db, "acme");
  globex = await seedWorkspaceGraph(db, "globex");
});

describe("workspace.counts", () => {
  it("refuses a caller with no session", async () => {
    expect(await code(() => caller(null).workspace.counts())).toBe("UNAUTHORIZED");
  });

  it("counts the caller's own Workspace and nobody else's", async () => {
    await seedIssue(db, acme.workspaceId, { title: "Ours" });
    await seedIssue(db, globex.workspaceId, { title: "Theirs" });
    await seedIssue(db, globex.workspaceId, { title: "Theirs too" });

    const counts = await caller({
      workspaceId: acme.workspaceId,
      userId: "ada",
    }).workspace.counts();

    expect(counts).toEqual({ unassignedIssues: 1, reviewByProject: [] });
  });
});

describe("task.recent", () => {
  it("refuses a caller with no session", async () => {
    expect(await code(() => caller(null).task.recent({}))).toBe("UNAUTHORIZED");
  });

  it("returns what this user opened, loaded, most recent first, with where each lives", async () => {
    const first = await seedTask(acme.workspaceId, "Opened first");
    const second = await seedTask(acme.workspaceId, "Opened second");
    const ada = caller({ workspaceId: acme.workspaceId, userId: "ada" });
    await ada.preference.recordRecentTask({ taskId: first });
    await ada.preference.recordRecentTask({ taskId: second });

    const recent = await ada.task.recent({});

    expect(recent.map((r) => r.task.title)).toEqual(["Opened second", "Opened first"]);
    expect(recent.every((r) => r.project === null)).toBe(true);
    expect(recent[0]?.task.state).toBe("review");
  });

  it("is per user: another person's visits are theirs", async () => {
    const id = await seedTask(acme.workspaceId, "Ada's");
    await caller({ workspaceId: acme.workspaceId, userId: "ada" }).preference.recordRecentTask({
      taskId: id,
    });

    const grace = await caller({ workspaceId: acme.workspaceId, userId: "grace" }).task.recent({});

    expect(grace).toEqual([]);
  });
});
