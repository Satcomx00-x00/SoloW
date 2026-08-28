import { randomUUID } from "node:crypto";
import type { AgentProtocol } from "@solow/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { agentCatalog } from "./schema.js";

/**
 * The catalog rows every Workspace starts with (issue #10, opencode added 2026-08-28).
 *
 * Agent identity is a row rather than an enum, which means a brand-new Workspace with zero
 * catalog rows could not create even the agents SoloW ships — so whatever creates a Workspace
 * must call `ensureDefaultAgentCatalog` immediately after, the same way it must create the
 * Workspace itself. Shared between the real sign-up hook (`auth.ts`) and the dev/test seed so
 * both paths guarantee the same thing.
 *
 * These are *defaults*, not a closed set: a Workspace can add its own rows through
 * `profile.agentCatalog.create`, and can edit these. Seeding them only means a fresh install has
 * something to point an Agent Profile at.
 *
 * The two env-var names on each row are what the billing guard sets and strips
 * (`resolveAgentRunEnv` in `@solow/core`): the subscription one for an agent's own plan, the
 * metered one for a per-token provider key. They are names, never values.
 */
interface CatalogDefault {
  key: string;
  displayName: string;
  protocol: AgentProtocol;
  command: string;
  argsTemplate: string[];
  subscriptionEnvVar: string;
  meteredEnvVar: string;
}

export const DEFAULT_AGENT_CATALOG: readonly CatalogDefault[] = [
  {
    key: "claude_code",
    displayName: "Claude Code",
    protocol: "claude_code_stream_json",
    command: "claude",
    argsTemplate: [],
    subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  },
  {
    /**
     * opencode speaks ACP natively — `opencode acp` is an Agent Client Protocol server, and it
     * negotiates protocol version 1, which is exactly what `@solow/acp` implements. So this is a
     * catalog row and nothing else: no new package, no runner, no protocol member. That is the
     * outcome Decision 0003 chose ACP for — a second agent should be configuration rather than
     * engineering — and this is the first row that actually demonstrates it.
     *
     * `OPENCODE_API_KEY` is opencode's own subscription key; `ANTHROPIC_API_KEY` is one provider
     * key among the hundred-odd it accepts, chosen because it is the provider SoloW's other
     * agent already uses. A Workspace wanting a different provider edits this row or adds its
     * own — which is precisely why the catalog is data.
     */
    key: "opencode",
    displayName: "opencode",
    protocol: "acp",
    command: "opencode",
    argsTemplate: ["acp"],
    subscriptionEnvVar: "OPENCODE_API_KEY",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  },
];

/** The key callers get an id back for — the agent a fresh Workspace's first Profile points at. */
const PRIMARY_KEY = "claude_code";

async function ensureRow(db: Db, workspaceId: string, entry: CatalogDefault): Promise<string> {
  const [existing] = await db
    .select({ id: agentCatalog.id })
    .from(agentCatalog)
    .where(and(eq(agentCatalog.workspaceId, workspaceId), eq(agentCatalog.key, entry.key)))
    .limit(1);
  if (existing) return existing.id;

  const id = randomUUID();
  await db.insert(agentCatalog).values({ id, workspaceId, ...entry });
  return id;
}

/**
 * Seed every default row this Workspace is missing, and answer with the id of the primary one.
 *
 * Check-then-insert per row, not a transaction: a Workspace is created by exactly one path
 * (sign-up is single-Owner; the seed is dev/test-only and not run concurrently with itself), so
 * there is no concurrent writer this needs to race against. Per row rather than "does the
 * Workspace have any rows at all", so a Workspace created before a default existed picks it up
 * on the next call instead of being stuck with the set it was born with.
 */
export async function ensureDefaultAgentCatalog(db: Db, workspaceId: string): Promise<string> {
  let primary: string | undefined;
  for (const entry of DEFAULT_AGENT_CATALOG) {
    const id = await ensureRow(db, workspaceId, entry);
    if (entry.key === PRIMARY_KEY) primary = id;
  }
  if (!primary) throw new Error(`no default catalog entry keyed ${PRIMARY_KEY}`);
  return primary;
}
