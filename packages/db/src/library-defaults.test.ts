/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { DEFAULT_MCP_SERVER, DEFAULT_SKILL, ensureDefaultLibraries } from "./library-defaults.js";
import { mcpServer, skill, workspace } from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";

describe("ensureDefaultLibraries", () => {
  let db: TestDb;
  let wsId: string;
  beforeEach(async () => {
    db = await createTestDb();
    const [ws] = await db.insert(workspace).values({ name: "Acme", ownerUserId: "o1" }).returning();
    if (!ws) throw new Error("seed");
    wsId = ws.id;
  });

  it("seeds one local MCP server and one Skill into an empty library, both switched off", async () => {
    expect(await ensureDefaultLibraries(db, wsId)).toEqual({ seededMcp: true, seededSkill: true });
    const servers = await db.select().from(mcpServer).where(eq(mcpServer.workspaceId, wsId));
    const skills = await db.select().from(skill).where(eq(skill.workspaceId, wsId));
    expect(servers.map((s) => [s.name, s.enabled, s.transport])).toEqual([
      ["memory", false, DEFAULT_MCP_SERVER.transport],
    ]);
    expect(skills.map((s) => [s.name, s.enabled, s.source.kind])).toEqual([
      [DEFAULT_SKILL.name, false, "inline"],
    ]);
    // Nothing in the default needs a Secret or a service: it must run on a fresh, offline install.
    expect(JSON.stringify(DEFAULT_MCP_SERVER.transport)).not.toContain("secret");
    expect(DEFAULT_MCP_SERVER.transport.kind).toBe("stdio");
  });

  it("is idempotent, and leaves a library the operator has shaped alone", async () => {
    await ensureDefaultLibraries(db, wsId);
    expect(await ensureDefaultLibraries(db, wsId)).toEqual({
      seededMcp: false,
      seededSkill: false,
    });
    // Remove the default: a restart must not bring it back.
    await db.delete(mcpServer).where(eq(mcpServer.workspaceId, wsId));
    await db.insert(mcpServer).values({
      workspaceId: wsId,
      name: "theirs",
      description: null,
      transport: { kind: "http", url: "https://x.example/mcp", headers: {} },
      enabled: true,
    });
    expect(await ensureDefaultLibraries(db, wsId)).toEqual({
      seededMcp: false,
      seededSkill: false,
    });
    const names = (await db.select().from(mcpServer).where(eq(mcpServer.workspaceId, wsId))).map(
      (s) => s.name,
    );
    expect(names).toEqual(["theirs"]);
  });
});
