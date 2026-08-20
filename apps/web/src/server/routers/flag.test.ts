/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * `flag.list` / `flag.set` at the API boundary (issue #21).
 *
 * The interesting case here is the flag guard itself: every other router in this app requires
 * `ff-core-program` to be ON (see `index.test.ts`'s "blocks every procedure when the flag is
 * OFF" test), but `flag.set` is the procedure that turns `ff-core-program` on in the first
 * place, so it must keep working for a caller whose context carries no flag override at all.
 */

async function seedWs(db: TestDb, name: string): Promise<string> {
  const [row] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!row) throw new Error("failed to seed workspace");
  return row.id;
}

/** Deliberately carries NO `flagOverrides` — the state of a real fresh Workspace's session. */
function caller(db: TestDb, workspaceId: string | null, userId = "user-1") {
  const ctx: BaseContext = {
    db,
    session: workspaceId ? { workspaceId, userId } : null,
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

describe("flag router", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("rejects an unauthenticated caller with UNAUTHORIZED", async () => {
    expect(await errCode(() => caller(db, null).flag.list({}))).toBe("UNAUTHORIZED");
    expect(
      await errCode(() => caller(db, null).flag.set({ key: "ff-core-program", enabled: true })),
    ).toBe("UNAUTHORIZED");
  });

  it("lists every flag with its static metadata and current (default) value", async () => {
    const wsId = await seedWs(db, "acme");
    const flags = await caller(db, wsId).flag.list({});

    const core = flags.find((f) => f.key === "ff-core-program");
    expect(core).toBeDefined();
    expect(core?.enabled).toBe(false);
    expect(core?.default).toBe(false);
    expect(core?.description.length).toBeGreaterThan(0);
  });

  it(
    "turns ff-core-program on with no flagOverrides on the context at all — the case every " +
      "other ownerProcedure-gated mutation cannot handle",
    async () => {
      const wsId = await seedWs(db, "acme");
      const c = caller(db, wsId);

      const result = await c.flag.set({ key: "ff-core-program", enabled: true });
      expect(result.enabled).toBe(true);

      const after = await c.flag.list({});
      expect(after.find((f) => f.key === "ff-core-program")?.enabled).toBe(true);
    },
  );

  it("persists a toggle so a fresh caller/context for the same Workspace sees it (reload)", async () => {
    const wsId = await seedWs(db, "acme");
    await caller(db, wsId).flag.set({ key: "ff-workflows", enabled: true });

    // A brand-new caller — the same round-trip a page reload makes.
    const reloaded = await caller(db, wsId).flag.list({});
    expect(reloaded.find((f) => f.key === "ff-workflows")?.enabled).toBe(true);
  });

  it("scopes flag.set to the caller's own Workspace — B cannot affect A's flags", async () => {
    const wsA = await seedWs(db, "workspace-a");
    const wsB = await seedWs(db, "workspace-b");

    await caller(db, wsB).flag.set({ key: "ff-workflows", enabled: true });

    const aFlags = await caller(db, wsA).flag.list({});
    expect(aFlags.find((f) => f.key === "ff-workflows")?.enabled).toBe(false);
  });

  it("rejects a key that is not a registered flag with BAD_REQUEST", async () => {
    const wsId = await seedWs(db, "acme");
    expect(
      await errCode(() => caller(db, wsId).flag.set({ key: "not-a-real-flag", enabled: true })),
    ).toBe("BAD_REQUEST");
  });
});
