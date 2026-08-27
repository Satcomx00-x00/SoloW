/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { uiPreference } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { getSurfaceLayout, setSurfaceLayout } from "./preference.js";
import { seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Surface arrangements as stored state (issue #3, AC-3): the half of "restore it on another
 * device" that a browser cannot provide. A second device is a second session against the same
 * row, so these tests are two contexts over one database — that is exactly the mechanism.
 */

let db: TestDb;
let acme: string;
let other: string;

const ctxFor = (workspaceId: string, userId: string): RequestContext => ({
  db,
  workspaceId,
  userId,
});

beforeEach(async () => {
  db = createTestDb();
  acme = (await seedWorkspaceGraph(db, "acme")).workspaceId;
  other = (await seedWorkspaceGraph(db, "other")).workspaceId;
});

describe("getSurfaceLayout", () => {
  it("returns the default arrangement when the user has never saved one", async () => {
    const result = await getSurfaceLayout(ctxFor(acme, "ada"), "status-bar");

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data.layout).toEqual({ order: [], hidden: [], shown: [], widths: {} });
  });

  it("restores what a different session for the same user saved — the cross-device claim", async () => {
    await setSurfaceLayout(ctxFor(acme, "ada"), {
      surface: "status-bar",
      layout: {
        order: ["status.review", "status.tasks"],
        hidden: ["status.workspace"],
        shown: [],
        widths: {},
      },
    });

    // A second device is a second RequestContext resolved from a second session.
    const onTheOtherDevice = await getSurfaceLayout(ctxFor(acme, "ada"), "status-bar");

    expect(onTheOtherDevice.ok).toBe(true);
    if (onTheOtherDevice.ok) {
      expect(onTheOtherDevice.data.layout.order).toEqual(["status.review", "status.tasks"]);
      expect(onTheOtherDevice.data.layout.hidden).toEqual(["status.workspace"]);
    }
  });

  it("keeps one user's arrangement out of another's, in the same Workspace", async () => {
    await setSurfaceLayout(ctxFor(acme, "ada"), {
      surface: "status-bar",
      layout: { order: ["status.review"], hidden: [], shown: [], widths: {} },
    });

    const grace = await getSurfaceLayout(ctxFor(acme, "grace"), "status-bar");

    expect(grace.ok).toBe(true);
    if (grace.ok) expect(grace.data.layout.order).toEqual([]);
  });

  it("keeps the same account's arrangements apart across Workspaces (Principle V)", async () => {
    await setSurfaceLayout(ctxFor(acme, "ada"), {
      surface: "status-bar",
      layout: { order: ["status.review"], hidden: [], shown: [], widths: {} },
    });

    const elsewhere = await getSurfaceLayout(ctxFor(other, "ada"), "status-bar");

    expect(elsewhere.ok).toBe(true);
    if (elsewhere.ok) expect(elsewhere.data.layout.order).toEqual([]);
  });

  it("keeps two surfaces apart, so arranging one does not rearrange the other", async () => {
    await setSurfaceLayout(ctxFor(acme, "ada"), {
      surface: "status-bar",
      layout: { order: ["status.review"], hidden: [], shown: [], widths: {} },
    });

    const commands = await getSurfaceLayout(ctxFor(acme, "ada"), "commands");

    expect(commands.ok).toBe(true);
    if (commands.ok) expect(commands.data.layout.order).toEqual([]);
  });

  it("states whose arrangement it is from the session, never from an argument", async () => {
    const result = await getSurfaceLayout(ctxFor(acme, "ada"), "status-bar");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.workspaceId).toBe(acme);
      expect(result.data.userId).toBe("ada");
    }
  });

  it("degrades a stored value that no longer parses to the default, rather than failing the read", async () => {
    // What a build that changed the shape of an arrangement leaves behind. A preference is
    // convenience state: a stale row must not be able to stop the shell rendering.
    await db.insert(uiPreference).values({
      workspaceId: acme,
      userId: "ada",
      key: "surface-layout:status-bar",
      value: { order: "not-a-list", hidden: [{ id: "status.tasks" }] },
    });

    const result = await getSurfaceLayout(ctxFor(acme, "ada"), "status-bar");

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.data.layout).toEqual({ order: [], hidden: [], shown: [], widths: {} });
  });
});

describe("setSurfaceLayout", () => {
  it("replaces the saved arrangement instead of adding a second row for the same surface", async () => {
    const ctx = ctxFor(acme, "ada");
    await setSurfaceLayout(ctx, {
      surface: "status-bar",
      layout: { order: ["a"], hidden: [], shown: [], widths: {} },
    });
    await setSurfaceLayout(ctx, {
      surface: "status-bar",
      layout: { order: ["b"], hidden: [], shown: [], widths: {} },
    });

    const rows = await db
      .select()
      .from(uiPreference)
      .where(and(eq(uiPreference.workspaceId, acme), eq(uiPreference.userId, "ada")));

    expect(rows).toHaveLength(1);
    const saved = await getSurfaceLayout(ctx, "status-bar");
    if (saved.ok) expect(saved.data.layout.order).toEqual(["b"]);
  });

  it("stores the arrangement under the tenant and user of the session", async () => {
    await setSurfaceLayout(ctxFor(acme, "ada"), {
      surface: "status-bar",
      layout: { order: ["status.tasks"], hidden: [], shown: [], widths: {} },
    });

    const [row] = await db.select().from(uiPreference);

    expect(row?.workspaceId).toBe(acme);
    expect(row?.userId).toBe("ada");
    expect(row?.key).toBe("surface-layout:status-bar");
  });
});
