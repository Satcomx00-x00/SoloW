/// <reference types="bun-types" />
import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { DEFAULT_AGENT_CATALOG, ensureDefaultAgentCatalog } from "./agent-catalog-defaults.js";
import { agentCatalog, workspace } from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";

/**
 * The rows a Workspace is born with (issue #10; opencode added 2026-08-28).
 *
 * What is worth pinning here is not that an insert happens, but the two properties callers
 * actually depend on: the seed is idempotent, and it is per *row* — so a Workspace created
 * before a default existed picks it up rather than being stuck with the set it was born with.
 */
describe("ensureDefaultAgentCatalog", () => {
  let db: TestDb;
  let workspaceId: string;

  beforeEach(async () => {
    db = createTestDb();
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Acme", ownerUserId: "owner-1" })
      .returning();
    workspaceId = ws?.id ?? "";
  });

  const rows = () =>
    db.select().from(agentCatalog).where(eq(agentCatalog.workspaceId, workspaceId));

  it("seeds every default, and answers with the Claude Code row's id", async () => {
    const id = await ensureDefaultAgentCatalog(db, workspaceId);

    const seeded = await rows();
    expect(seeded.map((r) => r.key).sort()).toEqual(["claude_code", "opencode"]);
    // The id is what a first Agent Profile is pointed at, so it has to be the primary row's.
    expect(seeded.find((r) => r.key === "claude_code")?.id).toBe(id);
  });

  it("gives opencode the ACP protocol and the `acp` subcommand", async () => {
    // opencode speaks ACP natively, which is the whole reason it needs no adapter of its own:
    // `opencode acp` is an Agent Client Protocol server at protocol version 1.
    await ensureDefaultAgentCatalog(db, workspaceId);

    const opencode = (await rows()).find((r) => r.key === "opencode");
    expect(opencode).toMatchObject({
      protocol: "acp",
      command: "opencode",
      argsTemplate: ["acp"],
    });
  });

  it("names an env var for each auth mode, never a value (Principle IV)", async () => {
    await ensureDefaultAgentCatalog(db, workspaceId);

    for (const row of await rows()) {
      expect(row.subscriptionEnvVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(row.meteredEnvVar).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(row.subscriptionEnvVar).not.toBe(row.meteredEnvVar);
    }
  });

  it("is idempotent — a second call inserts nothing and returns the same id", async () => {
    const first = await ensureDefaultAgentCatalog(db, workspaceId);
    const second = await ensureDefaultAgentCatalog(db, workspaceId);

    expect(second).toBe(first);
    expect(await rows()).toHaveLength(DEFAULT_AGENT_CATALOG.length);
  });

  it("backfills a default a Workspace predates, rather than skipping it", async () => {
    // The shape of every existing Workspace the moment a new default lands: it already has rows,
    // so a "seed only when empty" check would leave it without the new agent forever.
    await ensureDefaultAgentCatalog(db, workspaceId);
    await db.delete(agentCatalog).where(eq(agentCatalog.key, "opencode"));
    expect(await rows()).toHaveLength(1);

    await ensureDefaultAgentCatalog(db, workspaceId);

    expect((await rows()).map((r) => r.key).sort()).toEqual(["claude_code", "opencode"]);
  });

  it("keeps each Workspace's catalog to itself (Principle V)", async () => {
    const [other] = await db
      .insert(workspace)
      .values({ name: "Other Co", ownerUserId: "owner-2" })
      .returning();
    await ensureDefaultAgentCatalog(db, workspaceId);

    expect(
      await db
        .select()
        .from(agentCatalog)
        .where(eq(agentCatalog.workspaceId, other?.id ?? "")),
    ).toHaveLength(0);
  });
});
