import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { agentCatalog } from "./schema.js";

/**
 * The `claude_code` catalog row every Workspace needs before an Agent Profile can be created
 * (issue #10). Agent identity is now a row rather than an enum, which means a brand-new
 * Workspace with zero catalog rows could not create even the one agent SoloW actually
 * ships — so whatever creates a Workspace must call this immediately after, the same way it
 * must create the Workspace itself. Shared between the real sign-up hook (`auth.ts`) and the
 * dev/test seed so both paths guarantee the same thing.
 *
 * Check-then-insert, not a transaction: a Workspace is created by exactly one path (sign-up is
 * single-Owner; the seed is dev/test-only and not run concurrently with itself), so there is no
 * concurrent writer this needs to race against.
 */
export async function ensureDefaultAgentCatalog(db: Db, workspaceId: string): Promise<string> {
  const [existing] = await db
    .select({ id: agentCatalog.id })
    .from(agentCatalog)
    .where(and(eq(agentCatalog.workspaceId, workspaceId), eq(agentCatalog.key, "claude_code")))
    .limit(1);
  if (existing) return existing.id;

  const id = randomUUID();
  await db.insert(agentCatalog).values({
    id,
    workspaceId,
    key: "claude_code",
    displayName: "Claude Code",
    protocol: "claude_code_stream_json",
    command: "claude",
    argsTemplate: [],
    subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  });
  return id;
}
