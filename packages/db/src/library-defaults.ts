import { eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { mcpServer, skill } from "./schema.js";

/**
 * What a Workspace's libraries hold before anyone has added anything (spec F24): one MCP server
 * and one Skill, so the switch on a row and the picker on a Step have something to show, and a
 * first run can load *something* without an account being made anywhere.
 *
 * Seeded only into an **empty** library, not by name: a row the operator removed stays removed
 * across restarts, and a library they have filled themselves is theirs. Both ship switched off —
 * a default that quietly reached every harness run would be a default nobody chose.
 *
 * The server is `@modelcontextprotocol/server-memory`: a knowledge graph the harness reads and
 * writes, kept in a local file. No network beyond the package fetch, no token, no service.
 */
export const DEFAULT_MCP_SERVER = {
  name: "memory",
  description:
    "A knowledge-graph memory the harness can read and write across runs, kept in a local file — no network, no account.",
  transport: {
    kind: "stdio" as const,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: {},
  },
};

export const DEFAULT_SKILL = {
  name: "review-checklist",
  description:
    "What to check before calling a change done — tests, scope, secrets, and the summary.",
  source: {
    kind: "inline" as const,
    body: `# Review checklist

Before you call a change done, check each of these and say so in your summary.

## Correctness
- The change does what the issue asks — no more, no less.
- Every new branch of behaviour has a test, and the existing tests still pass.
- Errors are handled where they happen, with a message the next reader can act on.

## Scope
- No unrelated files were touched; no drive-by refactors.
- Names, comments and formatting match the surrounding code.

## Safety
- No secret, token or credential appears in the diff, the logs or the summary.
- Nothing destructive runs without the issue asking for it.

## Handoff
- The summary names what changed, what was checked, and anything left undone — precisely.
`,
  },
};

/** Whether the library has anything in it yet — the only thing the seed asks. */
async function libraryIsEmpty(
  db: Db,
  workspaceId: string,
): Promise<{ mcp: boolean; skills: boolean }> {
  const [servers, skills] = await Promise.all([
    db
      .select({ id: mcpServer.id })
      .from(mcpServer)
      .where(eq(mcpServer.workspaceId, workspaceId))
      .limit(1),
    db.select({ id: skill.id }).from(skill).where(eq(skill.workspaceId, workspaceId)).limit(1),
  ]);
  return { mcp: servers.length === 0, skills: skills.length === 0 };
}

export async function ensureDefaultLibraries(
  db: Db,
  workspaceId: string,
): Promise<{ seededMcp: boolean; seededSkill: boolean }> {
  const empty = await libraryIsEmpty(db, workspaceId);
  if (empty.mcp) {
    await db.insert(mcpServer).values({ workspaceId, ...DEFAULT_MCP_SERVER, enabled: false });
  }
  if (empty.skills) {
    await db.insert(skill).values({ workspaceId, ...DEFAULT_SKILL, enabled: false });
  }
  return { seededMcp: empty.mcp, seededSkill: empty.skills };
}
