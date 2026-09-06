/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { AgentLibraryErrorCode } from "@solow/contracts";
import { ensureDefaultAgentCatalog } from "./agent-catalog-defaults.js";
import {
  agentProfile,
  mcpServer,
  secret,
  skill,
  workflow,
  workflowStep,
  workspace,
} from "./schema.js";
import { createTestDb, type TestDb } from "./testing.js";

// The secret store reads SOLOW_SECRET_KEY through a cached env module, so the key has to be in
// place before the store is imported — the ordering `secret-store.test.ts` also has to respect.
let encryptSecret: typeof import("./secret-store.js").encryptSecret;
let loadAgentLibrariesForRun: typeof import("./agent-library-run.js").loadAgentLibrariesForRun;
beforeAll(async () => {
  process.env.SOLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
  ({ encryptSecret } = await import("./secret-store.js"));
  ({ loadAgentLibrariesForRun } = await import("./agent-library-run.js"));
});

/**
 * What a run is handed from the libraries (spec F24): the enabled items and the Step's own,
 * with Secrets decrypted — and refused by name when one is gone.
 */
describe("loadAgentLibrariesForRun", () => {
  let db: TestDb;
  let wsId: string;
  let otherWsId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const [ws] = await db.insert(workspace).values({ name: "Acme", ownerUserId: "o1" }).returning();
    const [other] = await db
      .insert(workspace)
      .values({ name: "Other", ownerUserId: "o2" })
      .returning();
    if (!ws || !other) throw new Error("seed");
    wsId = ws.id;
    otherWsId = other.id;
  });

  async function seedSecret(workspaceId: string, value: string): Promise<string> {
    const [row] = await db
      .insert(secret)
      .values({
        workspaceId,
        name: `s-${value}`,
        kind: "api_key",
        ciphertext: encryptSecret(value),
      })
      .returning();
    if (!row) throw new Error("seed");
    return row.id;
  }

  it("loads what is enabled plus what the step names, sorted by name, with secrets decrypted", async () => {
    const tokenId = await seedSecret(wsId, "tok-123");
    const [github] = await db
      .insert(mcpServer)
      .values({
        workspaceId: wsId,
        name: "github",
        transport: {
          kind: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: {
            GITHUB_TOKEN: { kind: "secret", secretId: tokenId },
            LOG_LEVEL: { kind: "literal", value: "info" },
          },
        },
        enabled: true,
      })
      .returning();
    const [docs] = await db
      .insert(mcpServer)
      .values({
        workspaceId: wsId,
        name: "docs",
        transport: { kind: "http", url: "https://docs.example/mcp", headers: {} },
        enabled: false,
      })
      .returning();
    await db.insert(mcpServer).values({
      workspaceId: wsId,
      name: "unused",
      transport: { kind: "http", url: "https://x.example/mcp", headers: {} },
      enabled: false,
    });
    const [reviewSkill] = await db
      .insert(skill)
      .values({
        workspaceId: wsId,
        name: "review-checklist",
        description: "How we review",
        source: { kind: "inline", body: "# Review\n\nCheck everything." },
        enabled: false,
      })
      .returning();
    await db.insert(skill).values({
      workspaceId: wsId,
      name: "always-on",
      description: "Everywhere",
      source: { kind: "path", path: "/srv/skills/always-on" },
      enabled: true,
    });
    if (!github || !docs || !reviewSkill) throw new Error("seed");

    // A Step needs a real Agent Profile behind it; the token above doubles as its credential.
    const agentCatalogId = await ensureDefaultAgentCatalog(db, wsId);
    const [profile] = await db
      .insert(agentProfile)
      .values({
        workspaceId: wsId,
        name: "Reviewer",
        agentCatalogId,
        authMode: "api_key",
        secretId: tokenId,
      })
      .returning();
    const [wf] = await db.insert(workflow).values({ workspaceId: wsId, name: "Ship" }).returning();
    const [step] = await db
      .insert(workflowStep)
      .values({
        workspaceId: wsId,
        workflowId: wf?.id ?? "",
        rank: "V",
        name: "Review",
        agentProfileId: profile?.id ?? "",
        mcpServerIds: [docs.id],
        skillIds: [reviewSkill.id],
      })
      .returning();
    if (!step) throw new Error("seed");

    const loaded = await loadAgentLibrariesForRun(db, wsId, step.id);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.data.mcpServers.map((s) => s.name)).toEqual(["docs", "github"]);
    expect(loaded.data.mcpServers[1]?.transport).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "tok-123", LOG_LEVEL: "info" },
    });
    expect(loaded.data.skills.map((s) => s.name)).toEqual(["always-on", "review-checklist"]);

    // No Step: only what is enabled.
    const bare = await loadAgentLibrariesForRun(db, wsId, null);
    if (!bare.ok) throw new Error(bare.error);
    expect(bare.data.mcpServers.map((s) => s.name)).toEqual(["github"]);
    expect(bare.data.skills.map((s) => s.name)).toEqual(["always-on"]);
  });

  it("refuses by name when a referenced secret is gone, or belongs to another workspace", async () => {
    const foreign = await seedSecret(otherWsId, "theirs");
    await db.insert(mcpServer).values({
      workspaceId: wsId,
      name: "leaky",
      transport: {
        kind: "http",
        url: "https://x.example/mcp",
        headers: { Authorization: { kind: "secret", secretId: foreign } },
      },
      enabled: true,
    });
    const loaded = await loadAgentLibrariesForRun(db, wsId, null);
    expect(loaded.ok ? null : loaded.error).toBe(AgentLibraryErrorCode.SecretMissing);
  });

  it("loads nothing from another workspace's libraries", async () => {
    await db.insert(mcpServer).values({
      workspaceId: otherWsId,
      name: "theirs",
      transport: { kind: "http", url: "https://x.example/mcp", headers: {} },
      enabled: true,
    });
    const loaded = await loadAgentLibrariesForRun(db, wsId, null);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.data.mcpServers).toEqual([]);
  });
});
