import { beforeEach, describe, expect, it } from "bun:test";
import { CommonErrorCode, HarnessConfigErrorCode } from "@solow/contracts";
import { createTestDb, type TestDb } from "@solow/db/testing";
import {
  createHarnessConfig,
  deleteHarnessConfig,
  duplicateHarnessConfig,
  exportHarnessConfig,
  getHarnessConfig,
  importHarnessConfig,
  listHarnessConfigs,
  updateHarnessConfig,
} from "./harness-config.js";
import {
  createHarnessCatalogEntry,
  createHarnessProfile,
  getHarnessProfile,
  updateHarnessProfile,
} from "./profile.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/** Harness Configs (Decision 0028): stored, shared and selected per Workspace. */
describe("Harness Configs", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  const claude = (name = "Strict") => ({
    name,
    harness: "claude_code" as const,
    content: { permissions: { deny: ["Bash(rm:*)"] } },
  });

  async function setup() {
    const g = await seedWorkspaceGraph(db, "acme");
    return { g, ctx: ctxFor(db, g.workspaceId) };
  }

  it("creates, lists and edits a config", async () => {
    const { ctx } = await setup();
    const created = await createHarnessConfig(ctx, claude());
    if (!created.ok) throw new Error(created.error);
    expect(created.data).toMatchObject({ name: "Strict", description: null, profileCount: 0 });

    const updated = await updateHarnessConfig(ctx, {
      id: created.data.id,
      harness: "claude_code",
      content: { model: "opus" },
      description: "  For review  ",
    });
    expect(updated.ok && updated.data).toMatchObject({
      content: { model: "opus" },
      description: "For review",
    });

    const list = await listHarnessConfigs(ctx, { harness: "opencode" });
    expect(list.ok && list.data).toEqual([]);
  });

  it("refuses a second config with one name, and a harness change", async () => {
    const { ctx } = await setup();
    const a = await createHarnessConfig(ctx, claude());
    if (!a.ok) throw new Error(a.error);
    expect(await createHarnessConfig(ctx, claude())).toEqual({
      ok: false,
      error: HarnessConfigErrorCode.NameTaken,
    });
    expect(await updateHarnessConfig(ctx, { id: a.data.id, harness: "opencode" })).toEqual({
      ok: false,
      error: HarnessConfigErrorCode.HarnessMismatch,
    });
  });

  it("duplicates and imports under a free name", async () => {
    const { ctx } = await setup();
    const a = await createHarnessConfig(ctx, claude());
    if (!a.ok) throw new Error(a.error);
    const copy = await duplicateHarnessConfig(ctx, { id: a.data.id });
    expect(copy.ok && copy.data).toMatchObject({ name: "Strict (copy)", content: a.data.content });

    const doc = await exportHarnessConfig(ctx, a.data.id);
    if (!doc.ok) throw new Error(doc.error);
    expect(doc.data).not.toHaveProperty("id");
    const imported = await importHarnessConfig(ctx, doc.data);
    expect(imported.ok && imported.data.name).toBe("Strict (copy 2)");
  });

  it("is Workspace-scoped (Principle V)", async () => {
    const { ctx } = await setup();
    const other = ctxFor(db, (await seedWorkspaceGraph(db, "other")).workspaceId);
    const a = await createHarnessConfig(ctx, claude());
    if (!a.ok) throw new Error(a.error);
    expect(await getHarnessConfig(other, a.data.id)).toEqual({
      ok: false,
      error: CommonErrorCode.NotFound,
    });
    expect(await deleteHarnessConfig(other, a.data.id)).toEqual({
      ok: false,
      error: CommonErrorCode.NotFound,
    });
  });

  it("a Profile selects only a config for its harness, and holds it from deletion", async () => {
    const { g, ctx } = await setup();
    const claudeConfig = await createHarnessConfig(ctx, claude());
    const ocConfig = await createHarnessConfig(ctx, {
      name: "oc",
      harness: "opencode",
      content: { theme: "dark" },
    });
    if (!claudeConfig.ok || !ocConfig.ok) throw new Error("seed failed");

    expect(
      await updateHarnessProfile(ctx, { id: g.agentProfileId, harnessConfigId: ocConfig.data.id }),
    ).toEqual({ ok: false, error: HarnessConfigErrorCode.HarnessMismatch });

    const bound = await updateHarnessProfile(ctx, {
      id: g.agentProfileId,
      harnessConfigId: claudeConfig.data.id,
    });
    expect(bound.ok && bound.data.harnessConfigId).toBe(claudeConfig.data.id);
    expect(await deleteHarnessConfig(ctx, claudeConfig.data.id)).toEqual({
      ok: false,
      error: HarnessConfigErrorCode.InUse,
    });
    const listed = await listHarnessConfigs(ctx, {});
    expect(listed.ok && listed.data.find((c) => c.id === claudeConfig.data.id)?.profileCount).toBe(
      1,
    );

    await updateHarnessProfile(ctx, { id: g.agentProfileId, harnessConfigId: null });
    const cleared = await getHarnessProfile(ctx, g.agentProfileId);
    expect(cleared.ok && cleared.data.harnessConfigId).toBeNull();
    expect((await deleteHarnessConfig(ctx, claudeConfig.data.id)).ok).toBe(true);
  });

  it("an opencode catalog row takes an opencode config", async () => {
    const { ctx } = await setup();
    const entry = await createHarnessCatalogEntry(ctx, {
      key: "oc_custom",
      displayName: "oc",
      protocol: "acp",
      command: "/usr/local/bin/opencode",
      argsTemplate: ["acp"],
      installHint: null,
      minVersion: null,
      subscriptionEnvVar: "OPENCODE_API_KEY",
      meteredEnvVar: "ANTHROPIC_API_KEY",
      capabilities: { models: [], modes: [] },
    });
    if (!entry.ok) throw new Error(entry.error);
    const oc = await createHarnessConfig(ctx, { name: "oc", harness: "opencode", content: {} });
    if (!oc.ok) throw new Error(oc.error);
    const profile = await createHarnessProfile(ctx, {
      name: "oc",
      agentCatalogId: entry.data.id,
      authMode: "api_key",
      secretId: "any",
      concurrencyCap: 1,
      permissionMode: "acceptEdits",
      model: null,
      modeId: null,
      harnessConfigId: oc.data.id,
    });
    expect(profile.ok && profile.data.harnessConfigId).toBe(oc.data.id);
  });
});
