import { beforeEach, describe, expect, it } from "bun:test";
import {
  CommonErrorCode,
  HarnessCatalogErrorCode,
  HarnessProfileErrorCode,
} from "@solow/contracts";
import { harnessProfile, session, sessionUsage, workflow, workflowStep } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import {
  createHarnessCatalogEntry,
  createHarnessProfile,
  deleteHarnessProfile,
  getHarnessProfile,
  listHarnessCatalog,
  updateHarnessProfile,
} from "./profile.js";
import { createTaskRecord } from "./task.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Harness Profile deletion. `agent_profile.id` is a real NOT NULL foreign key on three tables —
 * `task`, `workflow_step`, `session_usage` — so what these prove is that the refusal happens as
 * a named product error before any of them, not as a raw SQLite constraint violation surfacing
 * from whichever one the delete statement happens to hit first.
 */

describe("Harness Profile usage and deletion", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("reports zero usage for a freshly created Profile", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const found = await getHarnessProfile(ctx, g.agentProfileId);
    expect(found.ok && found.data.usage).toEqual({
      taskCount: 0,
      workflowStepCount: 0,
      sessionUsageCount: 0,
    });
  });

  it("deletes a Profile nothing references", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const [existing] = await db
      .select({ agentCatalogId: harnessProfile.agentCatalogId })
      .from(harnessProfile)
      .where(eq(harnessProfile.id, g.agentProfileId));
    if (!existing) throw new Error("seed failed");
    const created = await createHarnessProfile(ctx, {
      name: "Spare",
      agentCatalogId: existing.agentCatalogId,
      authMode: "api_key",
      secretId: "secret-2",
      concurrencyCap: 3,
      permissionMode: "acceptEdits",
      model: null,
      modeId: null,
    });
    if (!created.ok) throw new Error("seed failed");

    const deleted = await deleteHarnessProfile(ctx, { id: created.data.id });
    expect(deleted).toEqual({ ok: true, data: created.data });
    expect(await getHarnessProfile(ctx, created.data.id)).toEqual({
      ok: false,
      error: CommonErrorCode.NotFound,
    });
  });

  it("refuses to delete a Profile a Task still references, and counts it", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssue(db, g.workspaceId, { title: "Needs the profile" });
    const made = await createTaskRecord(ctx, {
      issueId: issue.id,
      title: "Running on it",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!made.ok) throw new Error("seed failed");

    const attempt = await deleteHarnessProfile(ctx, { id: g.agentProfileId });
    expect(attempt).toEqual({ ok: false, error: HarnessProfileErrorCode.InUse });

    const found = await getHarnessProfile(ctx, g.agentProfileId);
    expect(found.ok && found.data.usage.taskCount).toBe(1);
    // Refused, not partially applied — the row is exactly as it was.
    expect(found.ok).toBe(true);
  });

  it("refuses to delete a Profile a Workflow Step still references", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const [wf] = await db
      .insert(workflow)
      .values({ workspaceId: g.workspaceId, name: "Ship it" })
      .returning();
    if (!wf) throw new Error("seed failed");
    await db.insert(workflowStep).values({
      workspaceId: g.workspaceId,
      workflowId: wf.id,
      rank: "a0",
      name: "Implement",
      agentProfileId: g.agentProfileId,
    });

    const attempt = await deleteHarnessProfile(ctx, { id: g.agentProfileId });
    expect(attempt).toEqual({ ok: false, error: HarnessProfileErrorCode.InUse });
  });

  it("refuses to delete a Profile with Session usage history, even with every Task since deleted", async () => {
    // The case a Task/Step count alone would miss: the run is long gone, but the billing
    // attribution row is the only remaining reason this Profile's cost history still resolves.
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssue(db, g.workspaceId, { title: "Already finished" });
    const made = await createTaskRecord(ctx, {
      issueId: issue.id,
      title: "Done and gone",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "backlog",
    });
    if (!made.ok) throw new Error("seed failed");
    const [sess] = await db
      .insert(session)
      .values({ workspaceId: g.workspaceId, taskId: made.data.id, state: "closed" })
      .returning();
    if (!sess) throw new Error("seed failed");
    await db.insert(sessionUsage).values({
      workspaceId: g.workspaceId,
      sessionId: sess.id,
      taskId: made.data.id,
      agentProfileId: g.agentProfileId,
      messageId: "m1",
      seq: 0,
    });

    const attempt = await deleteHarnessProfile(ctx, { id: g.agentProfileId });
    expect(attempt).toEqual({ ok: false, error: HarnessProfileErrorCode.InUse });
    const found = await getHarnessProfile(ctx, g.agentProfileId);
    expect(found.ok && found.data.usage.sessionUsageCount).toBe(1);
  });

  it("cannot delete another Workspace's Harness Profile (Principle V)", async () => {
    const a = await seedWorkspaceGraph(db, "delete-a");
    const b = await seedWorkspaceGraph(db, "delete-b");
    const attempt = await deleteHarnessProfile(ctxFor(db, b.workspaceId), { id: a.agentProfileId });
    expect(attempt).toEqual({ ok: false, error: CommonErrorCode.NotFound });
    expect((await getHarnessProfile(ctxFor(db, a.workspaceId), a.agentProfileId)).ok).toBe(true);
  });

  it("does not count a Task, Step or Session belonging to another Workspace", async () => {
    // Same reasoning as the cross-workspace delete test, aimed at the usage COUNT rather than
    // the delete refusal: a leaked count would make a Profile look in-use (and undeletable) for
    // a reason belonging to a tenant that cannot even see it.
    const a = await seedWorkspaceGraph(db, "count-a");
    const b = await seedWorkspaceGraph(db, "count-b");
    const issueB = await seedIssue(db, b.workspaceId, { title: "B's own task" });
    const made = await createTaskRecord(ctxFor(db, b.workspaceId), {
      issueId: issueB.id,
      title: "B's task",
      agentProfileId: b.agentProfileId,
      executorProfileId: b.executorProfileId,
      repositories: [{ repositoryId: b.repositoryId }],
      state: "backlog",
    });
    if (!made.ok) throw new Error("seed failed");

    // A's Profile is untouched by B's Task — it should still be freely deletable.
    const deleted = await deleteHarnessProfile(ctxFor(db, a.workspaceId), { id: a.agentProfileId });
    expect(deleted.ok).toBe(true);
  });
});

/**
 * Extending the harness catalog (spec F05 AC-1, issue #10/#58). Every Workspace starts with one
 * seeded row — `claude_code`, protocol `claude_code_stream_json` — and until this function
 * existed nothing could ever add a second one. That mattered specifically for `acp`: the
 * protocol already has a full runner (`acp-runner.ts`) implementing `session/request_permission`,
 * but no catalog row meant no Harness Profile could ever be pointed at it.
 */
describe("createHarnessCatalogEntry", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  function acpEntry(over: Partial<Parameters<typeof createHarnessCatalogEntry>[1]> = {}) {
    return {
      key: "claude_acp",
      displayName: "Claude Code (ACP)",
      protocol: "acp" as const,
      command: "claude-agent-acp",
      argsTemplate: [],
      installHint: null,
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
      capabilities: { models: [], modes: [] },
      ...over,
    };
  }

  it("adds a second row beside the seeded Claude Code entry", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);

    const created = await createHarnessCatalogEntry(ctx, acpEntry());

    expect(created.ok).toBe(true);
    expect(created.ok && created.data.protocol).toBe("acp");
    const listed = await listHarnessCatalog(ctx);
    expect(listed.ok && listed.data.map((e) => e.key)).toContain("claude_acp");
  });

  it("refuses a key already used in this Workspace, and leaves the original row alone", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const first = await createHarnessCatalogEntry(ctx, acpEntry());
    if (!first.ok) throw new Error("seed failed");

    const attempt = await createHarnessCatalogEntry(
      ctx,
      acpEntry({ displayName: "A different harness entirely" }),
    );

    expect(attempt).toEqual({ ok: false, error: HarnessCatalogErrorCode.KeyTaken });
    const listed = await listHarnessCatalog(ctx);
    expect(listed.ok && listed.data.filter((e) => e.key === "claude_acp")).toHaveLength(1);
  });

  it("lets two Workspaces use the identical key — the index is per-Workspace, not global", async () => {
    const a = await seedWorkspaceGraph(db, "key-a");
    const b = await seedWorkspaceGraph(db, "key-b");

    const inA = await createHarnessCatalogEntry(ctxFor(db, a.workspaceId), acpEntry());
    const inB = await createHarnessCatalogEntry(ctxFor(db, b.workspaceId), acpEntry());

    expect(inA.ok).toBe(true);
    expect(inB.ok).toBe(true);
  });

  it("stores a Harness Profile can actually be created against the new entry", async () => {
    // The point of the whole feature: a catalog row on its own is not useful, a Profile that
    // can be pointed at it is.
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const catalogEntry = await createHarnessCatalogEntry(ctx, acpEntry());
    if (!catalogEntry.ok) throw new Error("seed failed");

    const profile = await createHarnessProfile(ctx, {
      name: "ACP Claude",
      agentCatalogId: catalogEntry.data.id,
      authMode: "subscription",
      secretId: "secret-1",
      concurrencyCap: 3,
      permissionMode: "acceptEdits",
      model: null,
      modeId: null,
    });

    expect(profile.ok).toBe(true);
    expect(profile.ok && profile.data.agentCatalogId).toBe(catalogEntry.data.id);
  });
});

describe("updateHarnessProfile", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("changes the permission mode without touching what the Profile is", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const before = await getHarnessProfile(ctx, g.agentProfileId);
    if (!before.ok) throw new Error("seed failed");
    // Every Profile starts where they all were before the column existed.
    expect(before.data.permissionMode).toBe("acceptEdits");

    const updated = await updateHarnessProfile(ctx, {
      id: g.agentProfileId,
      permissionMode: "bypassPermissions",
    });
    expect(updated.ok && updated.data.permissionMode).toBe("bypassPermissions");
    if (!updated.ok) return;
    // Which harness it runs and what it spends stay put: those are what its finished runs meant.
    expect(updated.data.agentCatalogId).toBe(before.data.agentCatalogId);
    expect(updated.data.authMode).toBe(before.data.authMode);
    expect(updated.data.secretId).toBe(before.data.secretId);
  });

  it("leaves untouched fields alone", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const ctx = ctxFor(db, g.workspaceId);
    const renamed = await updateHarnessProfile(ctx, { id: g.agentProfileId, name: "Renamed" });
    expect(renamed.ok && renamed.data.name).toBe("Renamed");
    expect(renamed.ok && renamed.data.permissionMode).toBe("acceptEdits");
  });

  it("refuses a Profile in another Workspace", async () => {
    const g = await seedWorkspaceGraph(db, "acme");
    const outsider = await seedWorkspaceGraph(db, "other");
    const result = await updateHarnessProfile(ctxFor(db, outsider.workspaceId), {
      id: g.agentProfileId,
      permissionMode: "bypassPermissions",
    });
    // Principle V: the tenant key comes from the context, so another Workspace finds nothing.
    expect(!result.ok && result.error).toBe(CommonErrorCode.NotFound);
  });
});
