/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * `profile.agentCatalog.create` reached through the real router (spec F05 AC-1, issue #10/#58).
 * The business rules — refuse a duplicate key, scope by Workspace — are proved at the DAL layer
 * (`dal/profile.test.ts`); what this file proves is the layer above it: the mutation is reachable
 * at all, requires auth like every other write here, and its output actually satisfies
 * `agentCatalogEntryDto` end to end through tRPC's own validation.
 */

async function seedWs(db: TestDb, name: string): Promise<string> {
  const [row] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!row) throw new Error("failed to seed workspace");
  return row.id;
}

function ctx(db: TestDb, workspaceId: string | null): BaseContext {
  return {
    db,
    session: workspaceId ? { workspaceId, userId: "user-1" } : null,
    ...(workspaceId ? { flagOverrides: { "ff-core-program": true } } : {}),
  };
}

function caller(db: TestDb, workspaceId: string | null) {
  return appRouter.createCaller(ctx(db, workspaceId));
}

describe("profile.agentCatalog.create", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("declares a new agent this Workspace can run, on the ACP protocol", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);

    const entry = await c.profile.agentCatalog.create({
      key: "claude_acp",
      displayName: "Claude Code (ACP)",
      protocol: "acp",
      command: "claude-agent-acp",
      argsTemplate: [],
      installHint: null,
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
      capabilities: { models: [], modes: [] },
    });

    expect(entry.protocol).toBe("acp");
    const listed = await c.profile.agentCatalog.list({});
    expect(listed.map((e) => e.key)).toContain("claude_acp");
  });

  it("rejects an unauthenticated call, same as every other write here", async () => {
    const c = caller(db, null);
    await expect(
      c.profile.agentCatalog.create({
        key: "claude_acp",
        displayName: "Claude Code (ACP)",
        protocol: "acp",
        command: "claude-agent-acp",
        argsTemplate: [],
        installHint: null,
        subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
        meteredEnvVar: "ANTHROPIC_API_KEY",
        capabilities: { models: [], modes: [] },
      }),
    ).rejects.toThrow();
  });

  it("refuses a key an uppercase or space slipped into (the input schema, not just the DAL)", async () => {
    const wsId = await seedWs(db, "acme");
    const c = caller(db, wsId);
    await expect(
      c.profile.agentCatalog.create({
        key: "Claude ACP",
        displayName: "Claude Code (ACP)",
        protocol: "acp",
        command: "claude-agent-acp",
        argsTemplate: [],
        installHint: null,
        subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
        meteredEnvVar: "ANTHROPIC_API_KEY",
        capabilities: { models: [], modes: [] },
      }),
    ).rejects.toThrow();
  });
});
