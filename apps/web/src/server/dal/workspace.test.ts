/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import { FLAGS, type FlagKey, isEnabled } from "../flags.js";
import { getWorkspaceFlags } from "./workspace.js";

/**
 * Per-Workspace feature flags (task TASK-001). The registry default is OFF and the kill switch
 * is "no override", so what matters is that nothing *except* an explicit `true` can turn the
 * core loop on — a missing row, a null column, or junk in it must all read as off.
 */

const WS = "11111111-1111-4111-8111-111111111111";

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await db.insert(workspace).values({ id: WS, name: "Owner's workspace", ownerUserId: "user-1" });
});

const setFlags = (value: unknown) =>
  db
    .update(workspace)
    .set({ enabledFlags: value as Record<string, boolean> })
    .where(eq(workspace.id, WS));

describe("getWorkspaceFlags", () => {
  it("reads an explicit override", async () => {
    await setFlags({ "ff-core-program": true });
    expect(await getWorkspaceFlags(db, WS)).toEqual({ "ff-core-program": true });
  });

  it("reads an explicit disable — the kill switch", async () => {
    await setFlags({ "ff-core-program": false });
    const flags = await getWorkspaceFlags(db, WS);
    expect(isEnabled("ff-core-program", { workspaceId: WS, overrides: flags })).toBe(false);
  });

  it("a fresh Workspace has no overrides, so the flag stays off", async () => {
    const flags = await getWorkspaceFlags(db, WS);
    expect(flags).toEqual({});
    expect(isEnabled("ff-core-program", { workspaceId: WS, overrides: flags })).toBe(false);
  });

  it("ignores unknown keys and non-boolean values rather than trusting them", async () => {
    // A corrupt column must never be read as "the feature is on".
    await setFlags({ "ff-core-program": "yes", "ff-something-else": true });
    expect(await getWorkspaceFlags(db, WS)).toEqual({});
  });

  it("reads every registered flag, not just the first one (regression)", async () => {
    // This function used to name `ff-core-program` literally, so every flag added afterwards was
    // silently dropped: `ff-integrations` could be true in this column and still evaluate to OFF,
    // with nothing to indicate why. Driving the check off the FLAGS registry is what fixes it, so
    // the guard is written against the registry rather than against today's list of keys.
    const everyFlagOn = Object.fromEntries(Object.keys(FLAGS).map((key) => [key, true]));
    await setFlags(everyFlagOn);

    const flags = await getWorkspaceFlags(db, WS);
    expect(Object.keys(flags).sort()).toEqual(Object.keys(FLAGS).sort());
    for (const key of Object.keys(FLAGS) as FlagKey[]) {
      expect(isEnabled(key, { workspaceId: WS, overrides: flags })).toBe(true);
    }
  });

  it("treats a malformed column as no overrides", async () => {
    for (const junk of [["ff-core-program"], "ff-core-program", 42]) {
      await setFlags(junk);
      expect(await getWorkspaceFlags(db, WS)).toEqual({});
    }
  });

  it("returns no overrides for a Workspace that does not exist", async () => {
    expect(await getWorkspaceFlags(db, "22222222-2222-4222-8222-222222222222")).toEqual({});
  });
});
