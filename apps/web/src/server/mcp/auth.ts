import "server-only";
import type { McpScope } from "@gatecontrol/contracts";
import { type Db, hashMcpToken, mcpToken } from "@gatecontrol/db";
import { and, eq, isNull } from "drizzle-orm";
import { getWorkspaceFlags } from "../dal/workspace.js";
import type { BaseContext } from "../trpc.js";

/**
 * MCP token authentication (issue #16 AC-3/AC-5).
 *
 * This module resolves a bearer token to a `BaseContext` and then stops. It deliberately makes
 * no authorisation decision beyond "is this token live" — the Workspace scoping, the feature
 * flag, and every ownership check are enforced downstream by the same tRPC middleware the SPA
 * goes through. Issue #16 names a second authorisation path as the one way this feature becomes
 * a security incident; the way to not have one is for this file to be unable to grant anything.
 */

export interface McpPrincipal {
  ctx: BaseContext;
  tokenId: string;
  scope: McpScope;
}

/** Pull the bearer value out of an Authorization header, tolerating case and padding. */
export function bearerFrom(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || null;
}

/**
 * Resolve a presented token to its Workspace, or null when it is unknown or revoked.
 *
 * Revocation is enforced in the query itself (`revokedAt IS NULL`) rather than by reading the row
 * and checking afterwards: a revoked token must be indistinguishable from a nonexistent one, and
 * the fewer branches between lookup and refusal, the fewer places that can regress (AC-5).
 */
export async function resolveMcpPrincipal(db: Db, presented: string): Promise<McpPrincipal | null> {
  const [row] = await db
    .select({
      id: mcpToken.id,
      workspaceId: mcpToken.workspaceId,
      scope: mcpToken.scope,
    })
    .from(mcpToken)
    .where(and(eq(mcpToken.tokenHash, hashMcpToken(presented)), isNull(mcpToken.revokedAt)))
    .limit(1);
  if (!row) return null;

  return {
    tokenId: row.id,
    scope: row.scope,
    ctx: {
      db,
      /**
       * The token is the principal, not a person. `userId` is stamped with the token's id rather
       * than borrowing a human's, so an action taken over MCP is attributable to the credential
       * that took it — `review.decide` records this as the deciding actor, and a decision made by
       * an external agent should not read as one a human made.
       */
      session: { workspaceId: row.workspaceId, userId: `mcp:${row.id}` },
      flagOverrides: await getWorkspaceFlags(db, row.workspaceId),
    },
  };
}

/** Record that a token was used. Best-effort: a failed stamp must not fail the caller's request. */
export async function stampTokenUsed(db: Db, tokenId: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(mcpToken)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(mcpToken.id, tokenId));
}

/** A `read` token may call queries only; mutations require `read_write`. */
export function scopeAllows(scope: McpScope, readOnly: boolean): boolean {
  return readOnly || scope === "read_write";
}
