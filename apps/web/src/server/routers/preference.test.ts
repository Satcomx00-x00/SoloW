/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
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
      layout: { order: ["status.review", "status.tasks"], hidden: [] },
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
          layout: { order: [], hidden: [] },
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
          layout: { order: ["A".repeat(500)], hidden: [] },
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
