import { agentProfile, executorProfile, repository, workspace } from "@gatecontrol/db";
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

  const [agent] = await db
    .insert(agentProfile)
    .values({ workspaceId: ws.id, name: "claude", authMode: "api_key", secretId: "secret-1" })
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
