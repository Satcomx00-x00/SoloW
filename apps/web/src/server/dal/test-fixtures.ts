import {
  agentCatalog,
  agentProfile,
  executorProfile,
  issue,
  repository,
  workspace,
} from "@gatecontrol/db";
import type { TestDb } from "@gatecontrol/db/testing";
import type { RequestContext } from "./context.js";

/**
 * Shared DAL test fixtures. A Task sits at the end of a chain of foreign keys — workspace →
 * agent profile / executor profile / repository / issue — so every test that touches one has to
 * build the whole graph. Kept here rather than copied into each suite.
 */
export async function seedWorkspaceGraph(db: TestDb, name: string) {
  const [ws] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");

  const [catalogEntry] = await db
    .insert(agentCatalog)
    .values({
      workspaceId: ws.id,
      key: "claude_code",
      displayName: "Claude Code",
      protocol: "claude_code_stream_json",
      command: "claude",
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
    })
    .returning();
  if (!catalogEntry) throw new Error("failed to seed agent catalog");

  const [agent] = await db
    .insert(agentProfile)
    .values({
      workspaceId: ws.id,
      name: "claude",
      agentCatalogId: catalogEntry.id,
      authMode: "api_key",
      secretId: "secret-1",
    })
    .returning();
  const [executor] = await db
    .insert(executorProfile)
    .values({ workspaceId: ws.id, name: "local" })
    .returning();
  const [repo] = await db
    .insert(repository)
    .values({
      workspaceId: ws.id,
      name: "gatecontrol",
      source: "local_path",
      location: "/srv/repos/gatecontrol",
    })
    .returning();
  if (!agent || !executor || !repo) throw new Error("failed to seed profiles");

  return {
    workspaceId: ws.id,
    agentProfileId: agent.id,
    executorProfileId: executor.id,
    repositoryId: repo.id,
  };
}

export function ctxFor(db: TestDb, workspaceId: string): RequestContext {
  return { db, workspaceId, userId: "user-1" };
}

/**
 * Insert an Issue directly (issue #15 product decision, 2026-08-19): there is no
 * `issue.create` procedure any more — every real Issue comes from `integration.importIssues`.
 * Tests that only need *an* Issue to exist, without exercising the import flow itself, insert
 * one straight into the table, the same way `seedWorkspaceGraph` seeds every other row here.
 */
export async function seedIssue(
  db: TestDb,
  workspaceId: string,
  overrides: Partial<typeof issue.$inferInsert> = {},
) {
  const [row] = await db
    .insert(issue)
    .values({ workspaceId, title: "Fixture issue", ...overrides })
    .returning();
  if (!row) throw new Error("failed to seed issue");
  return row;
}
