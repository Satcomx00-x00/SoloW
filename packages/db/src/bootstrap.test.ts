/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import { bootstrapWorkspace, LOCAL_WORKSPACE_ID } from "./bootstrap.js";
import {
  agentCatalog,
  agentProfile,
  executorProfile,
  repository,
  secret,
  workspace,
} from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";

/**
 * Bootstrap creates a Workspace, not a demo (2026-08-28).
 *
 * The fixture it replaced invented two companies with credentials, Agent Profiles and
 * repositories that never existed, which made a fresh install look configured and hid the real
 * first-run gap. The assertions that matter are therefore as much about what is *absent* as
 * what is present: anything invented here is something the setup checklist would then have to
 * pretend it did not invent.
 */
describe("bootstrapWorkspace", () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  it("creates exactly one Workspace and the catalog every Workspace needs", async () => {
    const result = await bootstrapWorkspace(db);

    expect(result).toEqual({ workspaceId: LOCAL_WORKSPACE_ID, created: true });
    expect(await db.select().from(workspace)).toHaveLength(1);
    // Reference data, not sample data: without it a new Workspace cannot name an agent at all.
    const catalog = await db.select().from(agentCatalog);
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.map((row) => row.key).sort()).toContain("opencode");
  });

  it("invents no credential, no profile and no repository", async () => {
    await bootstrapWorkspace(db);

    // Each of these was a fabricated row in the retired fixture. A Workspace that starts with a
    // Secret nobody added is a Workspace whose checklist is already lying.
    expect(await db.select().from(secret)).toHaveLength(0);
    expect(await db.select().from(agentProfile)).toHaveLength(0);
    expect(await db.select().from(executorProfile)).toHaveLength(0);
    expect(await db.select().from(repository)).toHaveLength(0);
  });

  it("leaves feature flags off, so the core loop stays a deliberate act", async () => {
    await bootstrapWorkspace(db);

    const [ws] = await db.select().from(workspace);
    expect(ws?.enabledFlags).toBeNull();
  });

  it("is a no-op on a database that already has its Workspace", async () => {
    await bootstrapWorkspace(db, { name: "Chosen name" });
    const second = await bootstrapWorkspace(db, { name: "Different name" });

    // `created: false` is what the CLI prints a different line for, and re-running must never
    // rename a Workspace its Owner has already named.
    expect(second.created).toBe(false);
    const rows = await db.select().from(workspace);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Chosen name");
  });

  it("keeps the id a local install's existing rows already reference", async () => {
    // Every Issue, Task and Session on disk points at this id. Changing it to tidy a name would
    // orphan all of them, so it is pinned by a test rather than by memory.
    expect(LOCAL_WORKSPACE_ID).toBe("11111111-1111-4111-8111-111111111111");
  });
});
