import { beforeEach, describe, expect, it } from "bun:test";

// The secret store reads GATECONTROL_SECRET_KEY lazily (via the validated env module),
// so setting it before the first encryptSecret call is sufficient. 32 bytes, base64.
process.env.GATECONTROL_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");

import { agentProfile, integration, secret } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { eq } from "drizzle-orm";
import { deleteSecret, listSecretRefs, setSecret } from "./secret.js";
import { ctxFor, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * Secret deletion (spec F17 FR-6).
 *
 * The interesting case is the refusal. `integration.secret_id` and `agent_profile.secret_id` are
 * plain columns, not foreign keys, so the database is not going to stop a delete that orphans
 * either of them — these tests are the thing that does, and they assert the row survives the
 * refusal rather than only that an error came back.
 */

let db: TestDb;
let workspaceId: string;
let agentProfileId: string;

beforeEach(async () => {
  db = createTestDb();
  const graph = await seedWorkspaceGraph(db, "acme");
  workspaceId = graph.workspaceId;
  agentProfileId = graph.agentProfileId;
});

/** Store a Secret through the DAL, so the value takes the same encrypted path as in production. */
async function storeSecret(wsId: string, name: string) {
  const result = await setSecret(ctxFor(db, wsId), { name, kind: "scm_pat", value: "pat-value" });
  if (!result.ok) throw new Error(`failed to store secret: ${result.error}`);
  return result.data;
}

describe("deleteSecret", () => {
  it("deletes a Secret nothing references", async () => {
    const ctx = ctxFor(db, workspaceId);
    const ref = await storeSecret(workspaceId, "spare-token");

    const result = await deleteSecret(ctx, { id: ref.id });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The metadata of what was removed comes back, so a caller can report it by name.
      expect(result.data.name).toBe("spare-token");
      expect(result.data.usedBy).toEqual([]);
    }

    const rows = await db.select().from(secret).where(eq(secret.id, ref.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses while an Integration holds it, and leaves the row intact", async () => {
    const ctx = ctxFor(db, workspaceId);
    const ref = await storeSecret(workspaceId, "github-pat");
    await db
      .insert(integration)
      .values({ workspaceId, provider: "github", secretId: ref.id, baseUrl: null });

    const result = await deleteSecret(ctx, { id: ref.id });
    expect(result).toEqual({ ok: false, error: "SECRET_IN_USE" });

    // The refusal is only worth anything if the credential really is still there afterwards.
    const rows = await db.select().from(secret).where(eq(secret.id, ref.id));
    expect(rows).toHaveLength(1);
  });

  it("refuses while an Agent Profile holds it", async () => {
    const ctx = ctxFor(db, workspaceId);
    const ref = await storeSecret(workspaceId, "anthropic-key");
    await db
      .update(agentProfile)
      .set({ secretId: ref.id })
      .where(eq(agentProfile.id, agentProfileId));

    expect(await deleteSecret(ctx, { id: ref.id })).toEqual({ ok: false, error: "SECRET_IN_USE" });
  });

  it("deletes once the last holder is gone", async () => {
    const ctx = ctxFor(db, workspaceId);
    const ref = await storeSecret(workspaceId, "github-pat");
    const [held] = await db
      .insert(integration)
      .values({ workspaceId, provider: "github", secretId: ref.id, baseUrl: null })
      .returning();
    if (!held) throw new Error("failed to seed integration");

    expect((await deleteSecret(ctx, { id: ref.id })).ok).toBe(false);
    await db.delete(integration).where(eq(integration.id, held.id));
    expect((await deleteSecret(ctx, { id: ref.id })).ok).toBe(true);
  });

  it("cannot delete another Workspace's Secret", async () => {
    const other = await seedWorkspaceGraph(db, "other");
    const ref = await storeSecret(other.workspaceId, "their-token");

    // Workspace-scoped (Principle V): from here the id is simply not found, not forbidden —
    // the row's existence is not something another tenant gets to learn.
    expect(await deleteSecret(ctxFor(db, workspaceId), { id: ref.id })).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
    expect(await db.select().from(secret).where(eq(secret.id, ref.id))).toHaveLength(1);
  });

  it("reports NOT_FOUND for an unknown id", async () => {
    expect(await deleteSecret(ctxFor(db, workspaceId), { id: "no-such-secret" })).toEqual({
      ok: false,
      error: "NOT_FOUND",
    });
  });
});

describe("listSecretRefs", () => {
  it("names each Secret's holders so the UI can explain a refusal before it happens", async () => {
    const ctx = ctxFor(db, workspaceId);
    const pat = await storeSecret(workspaceId, "github-pat");
    await storeSecret(workspaceId, "spare-token");
    await db
      .insert(integration)
      .values({ workspaceId, provider: "github", secretId: pat.id, baseUrl: null });
    await db
      .update(agentProfile)
      .set({ secretId: pat.id })
      .where(eq(agentProfile.id, agentProfileId));

    const result = await listSecretRefs(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byName = new Map(result.data.map((r) => [r.name, r]));
    expect(byName.get("github-pat")?.usedBy).toEqual([
      { holder: "integration", name: "github" },
      { holder: "agent_profile", name: "claude" },
    ]);
    expect(byName.get("spare-token")?.usedBy).toEqual([]);
  });

  it("never returns the ciphertext or the plaintext", async () => {
    await storeSecret(workspaceId, "github-pat");
    const result = await listSecretRefs(ctxFor(db, workspaceId));
    expect(JSON.stringify(result)).not.toContain("pat-value");
    expect(JSON.stringify(result)).not.toContain("ciphertext");
  });

  it("does not count another Workspace's Integration as a holder", async () => {
    const other = await seedWorkspaceGraph(db, "other");
    const ref = await storeSecret(workspaceId, "github-pat");
    // A cross-tenant row referencing this Secret's id must not make it look held here — and,
    // more importantly, must not block its Owner from deleting it.
    await db.insert(integration).values({
      workspaceId: other.workspaceId,
      provider: "github",
      secretId: ref.id,
      baseUrl: null,
    });

    const result = await listSecretRefs(ctxFor(db, workspaceId));
    expect(result.ok && result.data[0]?.usedBy).toEqual([]);
    expect((await deleteSecret(ctxFor(db, workspaceId), { id: ref.id })).ok).toBe(true);
  });
});

describe("setSecret", () => {
  it("reports the holders of a Secret it replaced", async () => {
    const ctx = ctxFor(db, workspaceId);
    const ref = await storeSecret(workspaceId, "github-pat");
    await db
      .insert(integration)
      .values({ workspaceId, provider: "gitlab", secretId: ref.id, baseUrl: null });

    // Replacing the value rotates the credential in place — the Integration still holds it.
    const replaced = await setSecret(ctx, {
      name: "github-pat",
      kind: "scm_pat",
      value: "rotated",
    });
    expect(replaced.ok && replaced.data.id).toBe(ref.id);
    expect(replaced.ok && replaced.data.usedBy).toEqual([
      { holder: "integration", name: "gitlab" },
    ]);
  });

  it("reports no holders for a Secret that did not exist a statement ago", async () => {
    const created = await setSecret(ctxFor(db, workspaceId), {
      name: "fresh",
      kind: "api_key",
      value: "sk-fresh",
    });
    expect(created.ok && created.data.usedBy).toEqual([]);
  });
});
