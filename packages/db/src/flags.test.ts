/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import { isEnabled } from "./flag-registry.js";
import { describeWorkspaceFlags, listWorkspaceFlags, setWorkspaceFlag } from "./flags.js";
import { workspace } from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";

/**
 * Flag persistence (constitution v1.5.0).
 *
 * One invariant carries this whole file, and it is the one the flip to default-ON depends on:
 * **"off" is an explicit stored `false`, never the absence of an entry.** While flags defaulted
 * OFF the column could have been a list of enabled names and nothing would have noticed; now, a
 * storage shape that could only record "on" would make the kill switch inexpressible — a flag
 * could be turned off in the UI and would read as on again on the next request, with no error
 * anywhere.
 *
 * So these tests are written against the round trip rather than against the setter alone: what
 * `setWorkspaceFlag` writes, `isEnabled` has to be able to read back as off.
 */

let db: TestDb;

beforeEach(async () => {
  db = createTestDb();
  await db.insert(workspace).values([
    { id: "ws-a", name: "acme", ownerUserId: "owner-a" },
    { id: "ws-b", name: "globex", ownerUserId: "owner-b" },
  ]);
});

const flagsOf = async (id: string) =>
  (await listWorkspaceFlags(db)).find((w) => w.id === id)?.flags ?? {};

describe("setWorkspaceFlag", () => {
  it("stores an explicit false, so the kill switch survives a default of ON", async () => {
    await setWorkspaceFlag(db, "ff-workflows", false, "ws-a");

    const stored = await flagsOf("ws-a");
    // The value itself, not merely "the key is absent from an enabled list".
    expect(stored["ff-workflows"]).toBe(false);
    expect(isEnabled("ff-workflows", { workspaceId: "ws-a", overrides: stored })).toBe(false);
  });

  it("round-trips a flag off and back on again", async () => {
    await setWorkspaceFlag(db, "ff-mcp", false, "ws-a");
    expect(isEnabled("ff-mcp", { workspaceId: "ws-a", overrides: await flagsOf("ws-a") })).toBe(
      false,
    );

    await setWorkspaceFlag(db, "ff-mcp", true, "ws-a");
    expect(isEnabled("ff-mcp", { workspaceId: "ws-a", overrides: await flagsOf("ws-a") })).toBe(
      true,
    );
  });

  it("leaves the other flags on the row alone", async () => {
    await setWorkspaceFlag(db, "ff-workflows", false, "ws-a");
    await setWorkspaceFlag(db, "ff-mcp", false, "ws-a");
    await setWorkspaceFlag(db, "ff-workflows", true, "ws-a");

    const stored = await flagsOf("ws-a");
    // A setter that replaced the object instead of merging into it would quietly turn `ff-mcp`
    // back on — and with defaults ON that is indistinguishable from "nobody ever set it".
    expect(stored["ff-mcp"]).toBe(false);
    expect(stored["ff-workflows"]).toBe(true);
  });

  it("writes only to the named Workspace (Principle V)", async () => {
    await setWorkspaceFlag(db, "ff-workflows", false, "ws-a");

    expect(await flagsOf("ws-b")).toEqual({});
    // And B therefore still reads the registry default, rather than inheriting A's kill switch.
    expect(
      isEnabled("ff-workflows", { workspaceId: "ws-b", overrides: await flagsOf("ws-b") }),
    ).toBe(true);
  });

  it("writes to every Workspace when none is named, which is what the operator script relies on", async () => {
    const changed = await setWorkspaceFlag(db, "ff-workflows", false);

    expect(changed.map((w) => w.id).sort()).toEqual(["ws-a", "ws-b"]);
    expect((await flagsOf("ws-a"))["ff-workflows"]).toBe(false);
    expect((await flagsOf("ws-b"))["ff-workflows"]).toBe(false);
  });

  it("reports no change for a Workspace id that matches nothing", async () => {
    // The operator script turns this into a usage error rather than printing a silent success.
    expect(await setWorkspaceFlag(db, "ff-workflows", false, "ws-nope")).toEqual([]);
  });
});

describe("listWorkspaceFlags", () => {
  it("reads an untouched Workspace as an empty override map, not as everything off", async () => {
    // The distinction the whole default-ON posture rests on: nothing stored is nothing *said*.
    expect(await flagsOf("ws-a")).toEqual({});
  });
});

/**
 * What `bun run flag list` prints.
 *
 * Worth a test of its own because it is the only place an operator finds out what is switched on
 * without opening a browser, and because it was silently wrong for the length of the default
 * flip: the line printed the *stored* keys, which is the empty set on a Workspace that has
 * everything enabled.
 */
describe("describeWorkspaceFlags", () => {
  it("says everything is on when nothing has been turned off", () => {
    // The fresh-install case, and the one the old line got backwards by printing "none enabled".
    expect(describeWorkspaceFlags({})).toBe("all on");
  });

  it("names only what somebody turned off", () => {
    expect(describeWorkspaceFlags({ "ff-mcp": false })).toBe("all on except ff-mcp");
    expect(describeWorkspaceFlags({ "ff-mcp": false, "ff-workflows": false })).toBe(
      "all on except ff-mcp, ff-workflows",
    );
  });

  it("does not name a flag that was explicitly turned on", () => {
    // A stored `true` is the same effective state as saying nothing, so it is not an exception.
    expect(describeWorkspaceFlags({ "ff-mcp": true })).toBe("all on");
  });

  it("ignores a key this build does not know, rather than reporting a flag that does not exist", () => {
    // A column written by a newer build must not make this one print an unrecognisable name to
    // an operator who then cannot act on it.
    expect(describeWorkspaceFlags({ "ff-from-the-future": false })).toBe("all on");
  });
});
