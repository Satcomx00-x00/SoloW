/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The preference procedures through the router (issue #3, AC-3), which is where the parts a DAL
 * test cannot see live: the session requirement, and the input schema refusing an arrangement a
 * client should never be able to send.
 */

let db: TestDb;
let workspaceId: string;

function caller(session: { workspaceId: string; userId: string } | null) {
  const ctx: BaseContext = {
    db,
    session,
    flagOverrides: { "ff-core-program": true },
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

beforeEach(async () => {
  db = createTestDb();
  const [row] = await db
    .insert(workspace)
    .values({ name: "acme", ownerUserId: "owner-acme" })
    .returning();
  workspaceId = row?.id ?? "";
});

describe("preference.setSurfaceLayout", () => {
  it("saves an arrangement the same user reads back on their next session", async () => {
    const first = caller({ workspaceId, userId: "ada" });
    await first.preference.setSurfaceLayout({
      surface: "status-bar",
      layout: { order: ["status.review", "status.tasks"], hidden: [], shown: [], widths: {} },
    });

    const second = caller({ workspaceId, userId: "ada" });
    const restored = await second.preference.getSurfaceLayout({ surface: "status-bar" });

    expect(restored.layout.order).toEqual(["status.review", "status.tasks"]);
  });

  it("refuses an unauthenticated caller, so a preference is never anonymous state", async () => {
    expect(
      await errCode(() => caller(null).preference.getSurfaceLayout({ surface: "status-bar" })),
    ).toBe("UNAUTHORIZED");
  });

  it("refuses a surface it does not have, rather than opening a free-form key space", async () => {
    const c = caller({ workspaceId, userId: "ada" });
    expect(
      await errCode(() =>
        c.preference.setSurfaceLayout({
          // @ts-expect-error — the point of the test is the runtime refusal of an unknown surface.
          surface: "anything-at-all",
          layout: { order: [], hidden: [], shown: [], widths: {} },
        }),
      ),
    ).toBe("BAD_REQUEST");
  });

  it("refuses an id a contribution could never have, so a layout cannot become storage", async () => {
    const c = caller({ workspaceId, userId: "ada" });
    expect(
      await errCode(() =>
        c.preference.setSurfaceLayout({
          surface: "status-bar",
          layout: { order: ["A".repeat(500)], hidden: [], shown: [], widths: {} },
        }),
      ),
    ).toBe("BAD_REQUEST");
  });

  it("refuses an arrangement longer than any surface could have", async () => {
    const c = caller({ workspaceId, userId: "ada" });
    expect(
      await errCode(() =>
        c.preference.setSurfaceLayout({
          surface: "status-bar",
          layout: { order: Array.from({ length: 201 }, (_, i) => `status.item-${i}`), hidden: [] },
        }),
      ),
    ).toBe("BAD_REQUEST");
  });
});

describe("preference.getReviewDraft / setReviewDraft / clearReviewDraft", () => {
  const draft = {
    sessionId: "sess-1",
    round: 2,
    viewed: [{ repositoryId: "repo-1", path: "src/a.ts" }],
    notes: [
      { repositoryId: "repo-1", path: "src/a.ts", side: "new" as const, line: 12, text: "?" },
    ],
    general: "looks close",
  };

  it("is null until something is saved, then reads back what the same user saved, per Task", async () => {
    const me = caller({ workspaceId, userId: "owner-acme" });
    expect((await me.preference.getReviewDraft({ taskId: "task-1" })).draft).toBeNull();

    await me.preference.setReviewDraft({ taskId: "task-1", draft });
    expect((await me.preference.getReviewDraft({ taskId: "task-1" })).draft).toEqual(draft);
    // Per Task: the draft on one is not the draft on another.
    expect((await me.preference.getReviewDraft({ taskId: "task-2" })).draft).toBeNull();
    // Per user: a colleague's reading is theirs.
    const other = caller({ workspaceId, userId: "other-user" });
    expect((await other.preference.getReviewDraft({ taskId: "task-1" })).draft).toBeNull();
  });

  it("replaces rather than merges, and forgets on clear", async () => {
    const me = caller({ workspaceId, userId: "owner-acme" });
    await me.preference.setReviewDraft({ taskId: "task-1", draft });
    await me.preference.setReviewDraft({
      taskId: "task-1",
      draft: { ...draft, round: 3, viewed: [], notes: [] },
    });
    const after = (await me.preference.getReviewDraft({ taskId: "task-1" })).draft;
    expect(after?.round).toBe(3);
    expect(after?.viewed).toEqual([]);

    await me.preference.clearReviewDraft({ taskId: "task-1" });
    expect((await me.preference.getReviewDraft({ taskId: "task-1" })).draft).toBeNull();
  });

  it("refuses a note with no text and an unauthenticated caller", async () => {
    const me = caller({ workspaceId, userId: "owner-acme" });
    expect(
      await errCode(() =>
        me.preference.setReviewDraft({
          taskId: "task-1",
          draft: { ...draft, notes: [{ ...draft.notes[0]!, text: "" }] },
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect(await errCode(() => caller(null).preference.getReviewDraft({ taskId: "task-1" }))).toBe(
      "UNAUTHORIZED",
    );
  });
});
