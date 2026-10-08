/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { seedWorkspaceGraph } from "../dal/test-fixtures.js";
import { resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The transcript window, through the router (Decision 0032).
 *
 * Both procedures are rate limited: the write because a loop that reached it would keep moving
 * the line the hourly sweep deletes up to, and the preview because each call walks every finished
 * transcript in the Workspace to size it.
 */

let db: TestDb;
let seeded: Awaited<ReturnType<typeof seedWorkspaceGraph>>;

function caller(session: { workspaceId: string; userId: string }) {
  const ctx: BaseContext = { db, session, flagOverrides: {} };
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

beforeEach(async () => {
  resetRateLimits();
  db = createTestDb();
  seeded = await seedWorkspaceGraph(db, "acme");
});

describe("workspace.setHistoryRetention", () => {
  it("allows ten changes a minute and refuses the next", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });
    for (let i = 0; i < 10; i += 1) {
      await api.workspace.setHistoryRetention({ days: i % 2 === 0 ? 7 : 30 });
    }

    expect(await errCode(() => api.workspace.setHistoryRetention({ days: null }))).toBe(
      "TOO_MANY_REQUESTS",
    );
    expect((await api.workspace.historyRetention()).days).toBe(30);
  });
});

describe("workspace.previewHistoryRetention", () => {
  it("allows thirty previews a minute and refuses the next", async () => {
    const api = caller({ workspaceId: seeded.workspaceId, userId: "ada" });
    for (let i = 0; i < 30; i += 1) {
      await api.workspace.previewHistoryRetention({ days: 7 });
    }

    expect(await errCode(() => api.workspace.previewHistoryRetention({ days: 7 }))).toBe(
      "TOO_MANY_REQUESTS",
    );
  });
});
