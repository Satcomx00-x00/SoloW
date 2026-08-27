/// <reference types="bun-types" />
import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { agentProfile, issue, secret, workspace } from "./schema.js";
import { seed } from "./seed.js";
import { createTestDb, type TestDb } from "./testing.js";

/**
 * Seed idempotency (task TASK-005). The seed must be safe to re-run: a second pass inserts
 * nothing new. Encryption needs SOLOW_SECRET_KEY, set before the store is used.
 */

async function count(db: TestDb, tbl: Parameters<ReturnType<TestDb["select"]>["from"]>[0]) {
  const rows = await db.select().from(tbl);
  return rows.length;
}

describe("seed", () => {
  let db: TestDb;

  beforeAll(() => {
    process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 9).toString("base64");
  });

  beforeEach(() => {
    db = createTestDb();
  });

  it("creates two non-overlapping workspaces with profiles, but no Issues (issue #15)", async () => {
    const res = await seed(db);
    expect(res.workspaceIds).toHaveLength(2);
    expect(new Set(res.workspaceIds).size).toBe(2);

    expect(await count(db, workspace)).toBe(2);
    expect(await count(db, agentProfile)).toBe(2);
    expect(await count(db, secret)).toBe(2);
    // A real Issue only ever comes from importing a connected GitHub/GitLab repository — a
    // seeded Workspace starts with none, the same as a fresh sign-up.
    expect(await count(db, issue)).toBe(0);
  });

  it("is idempotent — re-running does not duplicate rows", async () => {
    await seed(db);
    await seed(db);
    await seed(db);

    expect(await count(db, workspace)).toBe(2);
    expect(await count(db, agentProfile)).toBe(2);
    expect(await count(db, secret)).toBe(2);
  });

  it("stores secrets as ciphertext, never plaintext", async () => {
    await seed(db);
    const secrets = await db.select().from(secret);
    for (const s of secrets) {
      expect(s.ciphertext.split(".")).toHaveLength(3);
      expect(s.ciphertext).not.toContain("placeholder");
    }
  });
});
