import "server-only";
import {
  CommonErrorCode,
  err,
  type IssuedMcpTokenDto,
  type IssueMcpTokenInput,
  type McpTokenDto,
  ok,
  type Result,
} from "@gatecontrol/contracts";
import { generateMcpToken, mcpToken } from "@gatecontrol/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { mcpTokenToDto } from "./mappers.js";

/**
 * MCP access tokens (issue #16). Workspace-scoped like everything else (Principle V), and
 * write-only in the same sense as Secrets: `issue` is the only function that ever returns a
 * token value, and it returns it once (Principle IV / AC-4).
 */

export async function listMcpTokens(ctx: RequestContext): Promise<Result<McpTokenDto[]>> {
  const rows = await ctx.db
    .select()
    .from(mcpToken)
    .where(eq(mcpToken.workspaceId, ctx.workspaceId))
    .orderBy(desc(mcpToken.createdAt));
  return ok(rows.map(mcpTokenToDto));
}

/**
 * Issue a token. The value is generated here, hashed for storage, and handed back exactly once
 * — nothing persists it in recoverable form, so a lost token is reissued rather than looked up.
 */
export async function issueMcpToken(
  ctx: RequestContext,
  input: IssueMcpTokenInput,
): Promise<Result<IssuedMcpTokenDto, typeof CommonErrorCode.ValidationFailed>> {
  const generated = generateMcpToken();
  const [row] = await ctx.db
    .insert(mcpToken)
    .values({
      workspaceId: ctx.workspaceId,
      label: input.label,
      scope: input.scope,
      tokenHash: generated.hash,
      prefix: generated.prefix,
    })
    .returning();
  if (!row) return err(CommonErrorCode.ValidationFailed);
  return ok({ token: mcpTokenToDto(row), value: generated.value });
}

/**
 * Revoke a token. The row is kept (revoked, not deleted) so the audit trail survives; the
 * update is workspace-scoped so one Workspace cannot revoke another's token by guessing an id.
 * Already-revoked tokens are matched out by `revokedAt IS NULL`, making a second revoke a
 * NotFound rather than a silent success that resets the timestamp.
 */
export async function revokeMcpToken(
  ctx: RequestContext,
  id: string,
): Promise<Result<McpTokenDto, typeof CommonErrorCode.NotFound>> {
  const now = new Date().toISOString();
  const [row] = await ctx.db
    .update(mcpToken)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(mcpToken.workspaceId, ctx.workspaceId),
        eq(mcpToken.id, id),
        isNull(mcpToken.revokedAt),
      ),
    )
    .returning();
  return row ? ok(mcpTokenToDto(row)) : err(CommonErrorCode.NotFound);
}
