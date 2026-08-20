import "server-only";
import {
  CommonErrorCode,
  type DeleteSecretInput,
  err,
  ok,
  type Result,
  SecretErrorCode,
  type SecretRefDto,
  type SecretUsageDto,
  type SetSecretInput,
} from "@gatecontrol/contracts";
import { agentProfile, encryptSecret, integration, secret } from "@gatecontrol/db";
import { and, desc, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { secretToRef } from "./mappers.js";

/**
 * Which Secrets are spoken for, keyed by Secret id.
 *
 * `integration.secret_id` and `agent_profile.secret_id` are plain columns, not foreign keys, so
 * the database will not stop a Secret being deleted out from under either of them. This is the
 * check that does — and it runs on reads too, so the UI can name the holder before the user
 * reaches for Delete rather than only after the server refuses.
 */
async function loadSecretUsage(ctx: RequestContext): Promise<Map<string, SecretUsageDto[]>> {
  const [integrations, profiles] = await Promise.all([
    ctx.db
      .select({ secretId: integration.secretId, provider: integration.provider })
      .from(integration)
      .where(eq(integration.workspaceId, ctx.workspaceId)),
    ctx.db
      .select({ secretId: agentProfile.secretId, name: agentProfile.name })
      .from(agentProfile)
      .where(eq(agentProfile.workspaceId, ctx.workspaceId)),
  ]);

  const usage = new Map<string, SecretUsageDto[]>();
  const add = (secretId: string, entry: SecretUsageDto) => {
    const existing = usage.get(secretId);
    if (existing) existing.push(entry);
    else usage.set(secretId, [entry]);
  };
  for (const row of integrations) add(row.secretId, { holder: "integration", name: row.provider });
  for (const row of profiles) add(row.secretId, { holder: "agent_profile", name: row.name });
  return usage;
}

/** List Secret *metadata* (id/name/kind/usedBy) — never the value (Principle IV). */
export async function listSecretRefs(ctx: RequestContext): Promise<Result<SecretRefDto[]>> {
  const [rows, usage] = await Promise.all([
    ctx.db
      .select({ id: secret.id, name: secret.name, kind: secret.kind })
      .from(secret)
      .where(eq(secret.workspaceId, ctx.workspaceId))
      .orderBy(desc(secret.createdAt)),
    loadSecretUsage(ctx),
  ]);
  return ok(rows.map((row) => secretToRef(row, usage.get(row.id) ?? [])));
}

/**
 * Set (create or replace) a Secret. The value is encrypted before storage and the
 * response is metadata only — the plaintext is never returned (Principle IV / spec F17).
 */
export async function setSecret(
  ctx: RequestContext,
  input: SetSecretInput,
): Promise<Result<SecretRefDto>> {
  const ciphertext = encryptSecret(input.value);
  const [existing] = await ctx.db
    .select({ id: secret.id })
    .from(secret)
    .where(and(eq(secret.workspaceId, ctx.workspaceId), eq(secret.name, input.name)))
    .limit(1);

  if (existing) {
    const [row] = await ctx.db
      .update(secret)
      .set({ ciphertext, kind: input.kind, updatedAt: new Date().toISOString() })
      .where(and(eq(secret.workspaceId, ctx.workspaceId), eq(secret.id, existing.id)))
      .returning({ id: secret.id, name: secret.name, kind: secret.kind });
    if (!row) return err(CommonErrorCode.ValidationFailed);
    // Replacing the value does not change who holds the Secret — the id is the same row.
    const usage = await loadSecretUsage(ctx);
    return ok(secretToRef(row, usage.get(row.id) ?? []));
  }

  const [row] = await ctx.db
    .insert(secret)
    .values({ workspaceId: ctx.workspaceId, name: input.name, kind: input.kind, ciphertext })
    .returning({ id: secret.id, name: secret.name, kind: secret.kind });
  // Nothing can reference a Secret that did not exist a statement ago.
  return row ? ok(secretToRef(row)) : err(CommonErrorCode.ValidationFailed);
}

/**
 * Delete a Secret, refusing while anything still holds it (spec F17 FR-6).
 *
 * The refusal is the point. GateControl keeps the only copy of the value, so deleting one an
 * Integration or Agent Profile points at cannot be undone by re-entering it — that holder would
 * keep a `secret_id` naming a row that no longer exists, and say nothing about it until its next
 * sync or agent run failed to authenticate. The returned metadata is the row as it was, so a
 * caller can report what it removed.
 */
export async function deleteSecret(
  ctx: RequestContext,
  input: DeleteSecretInput,
): Promise<Result<SecretRefDto, typeof CommonErrorCode.NotFound | typeof SecretErrorCode.InUse>> {
  const [row] = await ctx.db
    .select({ id: secret.id, name: secret.name, kind: secret.kind })
    .from(secret)
    .where(and(eq(secret.workspaceId, ctx.workspaceId), eq(secret.id, input.id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const usedBy = (await loadSecretUsage(ctx)).get(row.id) ?? [];
  if (usedBy.length > 0) return err(SecretErrorCode.InUse);

  await ctx.db
    .delete(secret)
    .where(and(eq(secret.workspaceId, ctx.workspaceId), eq(secret.id, row.id)));
  return ok(secretToRef(row));
}

/**
 * ORCHESTRATOR-ONLY. Returns the encrypted ciphertext for a Secret so the orchestrator
 * can decrypt it (via `decryptForAgentRun`) and inject a single credential into an agent
 * process. NOT for the web/API layer, and never mapped into a DTO. (Finding C1.)
 */
export async function getSecretCiphertextForAgentRun(
  ctx: RequestContext,
  secretId: string,
): Promise<Result<string, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select({ ciphertext: secret.ciphertext })
    .from(secret)
    .where(and(eq(secret.workspaceId, ctx.workspaceId), eq(secret.id, secretId)))
    .limit(1);
  return row ? ok(row.ciphertext) : err(CommonErrorCode.NotFound);
}
