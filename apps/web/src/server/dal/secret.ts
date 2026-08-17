import "server-only";
import { and, eq } from "drizzle-orm";
import {
  type Result,
  type SecretRefDto,
  type SetSecretInput,
  CommonErrorCode,
  err,
  ok,
} from "@gatecontrol/contracts";
import { encryptSecret, secret } from "@gatecontrol/db";
import type { RequestContext } from "./context.js";
import { secretToRef } from "./mappers.js";

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
    return row ? ok(secretToRef(row)) : err(CommonErrorCode.ValidationFailed);
  }

  const [row] = await ctx.db
    .insert(secret)
    .values({ workspaceId: ctx.workspaceId, name: input.name, kind: input.kind, ciphertext })
    .returning({ id: secret.id, name: secret.name, kind: secret.kind });
  return row ? ok(secretToRef(row)) : err(CommonErrorCode.ValidationFailed);
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
