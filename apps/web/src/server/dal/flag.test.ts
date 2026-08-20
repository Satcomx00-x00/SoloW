import { beforeEach, describe, expect, it } from "bun:test";
import { FLAGS } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { listFlags, setFlag } from "./flag.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Feature flags surfaced from Settings (issue #21). `listFlags` merges the static registry
 * (`FLAGS`) with the Workspace's stored overrides; `setFlag` writes one override, always scoped
 * to the caller's own Workspace (Principle V) — never to a Workspace named by the caller.
 */

let db: TestDb;
let workspaceIdA: string;
let workspaceIdB: string;

beforeEach(async () => {
  db = createTestDb();
  workspaceIdA = (await seedWorkspaceGraph(db, "acme")).workspaceId;
  workspaceIdB = (await seedWorkspaceGraph(db, "globex")).workspaceId;
});

describe("listFlags", () => {
  it("returns every registered flag, with its static description and default", async () => {
    const result = await listFlags(ctxFor(db, workspaceIdA));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const keys = result.data.map((f) => f.key).sort();
    expect(keys).toEqual(Object.keys(FLAGS).sort());
    const core = result.data.find((f) => f.key === "ff-core-program");
    expect(core?.description).toBe(FLAGS["ff-core-program"].description);
    expect(core?.default).toBe(FLAGS["ff-core-program"].default);
  });

  it("reports an untouched flag as its registry default (OFF)", async () => {
    const result = await listFlags(ctxFor(db, workspaceIdA));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const flag of result.data) {
      expect(flag.enabled).toBe(flag.default);
    }
  });
});

describe("setFlag", () => {
  it("persists a flag and a later listFlags on the same Workspace reflects it", async () => {
    const ctx = ctxFor(db, workspaceIdA);
    const written = await setFlag(ctx, { key: "ff-workflows", enabled: true });
    expect(written).toEqual({
      ok: true,
      data: {
        key: "ff-workflows",
        description: FLAGS["ff-workflows"].description,
        default: FLAGS["ff-workflows"].default,
        enabled: true,
      },
    });

    const after = await listFlags(ctx);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.find((f) => f.key === "ff-workflows")?.enabled).toBe(true);
  });

  it("leaves the other flags on the same Workspace untouched", async () => {
    const ctx = ctxFor(db, workspaceIdA);
    await setFlag(ctx, { key: "ff-workflows", enabled: true });

    const after = await listFlags(ctx);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.find((f) => f.key === "ff-core-program")?.enabled).toBe(false);
    expect(after.data.find((f) => f.key === "ff-integrations")?.enabled).toBe(false);
  });

  it("does not affect another Workspace's flags (Principle V)", async () => {
    await setFlag(ctxFor(db, workspaceIdA), { key: "ff-workflows", enabled: true });

    const bResult = await listFlags(ctxFor(db, workspaceIdB));
    expect(bResult.ok).toBe(true);
    if (!bResult.ok) return;
    expect(bResult.data.find((f) => f.key === "ff-workflows")?.enabled).toBe(false);
  });

  it("rejects a key that is not in the flag registry, and writes nothing", async () => {
    const ctx = ctxFor(db, workspaceIdA);
    const result = await setFlag(ctx, { key: "ff-not-a-real-flag", enabled: true });
    expect(result).toEqual({ ok: false, error: "VALIDATION_FAILED" });

    const after = await listFlags(ctx);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // Every known flag is still at its default — the rejected write touched none of them.
    for (const flag of after.data) expect(flag.enabled).toBe(flag.default);
  });

  it("turns a flag back off again", async () => {
    const ctx = ctxFor(db, workspaceIdA);
    await setFlag(ctx, { key: "ff-mcp", enabled: true });
    await setFlag(ctx, { key: "ff-mcp", enabled: false });

    const after = await listFlags(ctx);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data.find((f) => f.key === "ff-mcp")?.enabled).toBe(false);
  });
});
