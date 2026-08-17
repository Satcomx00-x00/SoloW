/// <reference types="bun-types" />
import { beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { workspace } from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";

/**
 * createTestDb builds an in-memory SQLite with every migration applied. A trivial insert/select
 * on the tenant-root `workspace` table proves the migrations ran and the schema is queryable.
 */
describe("createTestDb", () => {
  let db: TestDb;

  beforeAll(() => {
    db = createTestDb();
  });

  it("round-trips an insert/select on the workspace table", () => {
    const inserted = db
      .insert(workspace)
      .values({ name: "Acme", ownerUserId: "user-1" })
      .returning()
      .all()[0]!;

    // id and timestamps are populated by schema defaults.
    expect(inserted.id).toBeTruthy();
    expect(inserted.name).toBe("Acme");
    expect(inserted.ownerUserId).toBe("user-1");
    expect(inserted.createdAt).toBeTruthy();

    const found = db.select().from(workspace).where(eq(workspace.id, inserted.id)).all();

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(inserted);
  });

  it("returns isolated databases across calls", () => {
    const other = createTestDb();
    other.insert(workspace).values({ name: "Solo", ownerUserId: "u" }).run();

    // The first db should not see rows written to a separately-created instance.
    expect(other.select().from(workspace).all()).toHaveLength(1);
  });
});
