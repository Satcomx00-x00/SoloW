import { ensureDefaultAgentCatalog } from "./agent-catalog-defaults.js";
import type { Db } from "./index.js";
import {
  agentProfile,
  executorProfile,
  issue,
  repository,
  secret,
  task,
  workspace,
} from "./schema.js";
import { encryptSecret } from "./secret-store.js";

/**
 * Seed data (task TASK-005). Two Workspaces with *non-overlapping* Issues/Tasks/Profiles so
 * the cross-Workspace isolation tests (Principle V) have realistic tenants to run against.
 *
 * Idempotent: every row uses a fixed id and `onConflictDoNothing`, so re-running the seed is
 * safe and never duplicates. Secrets are encrypted at rest via the same store the app uses —
 * so `GATECONTROL_SECRET_KEY` must be present in the environment before calling `seed`.
 */

// Stable ids make the seed idempotent (fixed PKs → onConflictDoNothing is a no-op on re-run).
// Exported so the local dev-owner session (apps/web) can bind to a seeded Workspace.
export const SEED_WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
export const SEED_WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const WS_A = SEED_WORKSPACE_A;
const WS_B = SEED_WORKSPACE_B;

const A = {
  secret: "a1000000-0000-4000-8000-000000000001",
  agent: "a2000000-0000-4000-8000-000000000002",
  executor: "a3000000-0000-4000-8000-000000000003",
  repo: "a4000000-0000-4000-8000-000000000004",
  issue: "a5000000-0000-4000-8000-000000000005",
  task: "a6000000-0000-4000-8000-000000000006",
} as const;

const B = {
  secret: "b1000000-0000-4000-8000-000000000001",
  agent: "b2000000-0000-4000-8000-000000000002",
  executor: "b3000000-0000-4000-8000-000000000003",
  repo: "b4000000-0000-4000-8000-000000000004",
  issue: "b5000000-0000-4000-8000-000000000005",
  task: "b6000000-0000-4000-8000-000000000006",
} as const;

export interface SeedResult {
  workspaceIds: [string, string];
}

/** Insert the two-Workspace fixture. Safe to run repeatedly. */
export async function seed(db: Db): Promise<SeedResult> {
  // --- Workspace A: Northwind Robotics (subscription billing) ---
  await db
    .insert(workspace)
    .values({ id: WS_A, name: "Northwind Robotics", ownerUserId: "user-northwind" })
    .onConflictDoNothing();
  await db
    .insert(secret)
    .values({
      id: A.secret,
      workspaceId: WS_A,
      name: "claude-subscription",
      kind: "subscription_token",
      ciphertext: encryptSecret("sub-token-northwind-placeholder"),
    })
    .onConflictDoNothing();
  await db
    .insert(agentProfile)
    .values({
      id: A.agent,
      workspaceId: WS_A,
      name: "Claude Code (subscription)",
      agentCatalogId: await ensureDefaultAgentCatalog(db, WS_A),
      authMode: "subscription",
      secretId: A.secret,
      concurrencyCap: 3,
    })
    .onConflictDoNothing();
  await db
    .insert(executorProfile)
    .values({
      id: A.executor,
      workspaceId: WS_A,
      name: "Local executor",
      kind: "local",
      config: { kind: "local", env: {} },
    })
    .onConflictDoNothing();
  await db
    .insert(repository)
    .values({
      id: A.repo,
      workspaceId: WS_A,
      name: "gate-firmware",
      source: "local_path",
      location: "/srv/repos/northwind/gate-firmware",
    })
    .onConflictDoNothing();
  await db
    .insert(issue)
    .values({
      id: A.issue,
      workspaceId: WS_A,
      title: "Gate servo stalls under load",
      description: "The main servo stalls when the gate is pushed against wind resistance.",
      status: "open",
    })
    .onConflictDoNothing();
  await db
    .insert(task)
    .values({
      id: A.task,
      workspaceId: WS_A,
      issueId: A.issue,
      title: "Investigate servo current-draw limits",
      state: "backlog",
      agentProfileId: A.agent,
      executorProfileId: A.executor,
      repositoryId: A.repo,
      baseRef: "main",
    })
    .onConflictDoNothing();

  // --- Workspace B: Harbor Freight Automation (API-key billing) ---
  await db
    .insert(workspace)
    .values({ id: WS_B, name: "Harbor Freight Automation", ownerUserId: "user-harbor" })
    .onConflictDoNothing();
  await db
    .insert(secret)
    .values({
      id: B.secret,
      workspaceId: WS_B,
      name: "anthropic-api-key",
      kind: "api_key",
      ciphertext: encryptSecret("sk-ant-harbor-placeholder"),
    })
    .onConflictDoNothing();
  await db
    .insert(agentProfile)
    .values({
      id: B.agent,
      workspaceId: WS_B,
      name: "Claude Code (API key)",
      agentCatalogId: await ensureDefaultAgentCatalog(db, WS_B),
      authMode: "api_key",
      secretId: B.secret,
      concurrencyCap: 5,
    })
    .onConflictDoNothing();
  await db
    .insert(executorProfile)
    .values({
      id: B.executor,
      workspaceId: WS_B,
      name: "Local executor",
      kind: "local",
      config: { kind: "local", env: {} },
    })
    .onConflictDoNothing();
  await db
    .insert(repository)
    .values({
      id: B.repo,
      workspaceId: WS_B,
      name: "keypad-driver",
      source: "remote_url",
      location: "https://github.com/harbor-freight/keypad-driver.git",
    })
    .onConflictDoNothing();
  await db
    .insert(issue)
    .values({
      id: B.issue,
      workspaceId: WS_B,
      title: "Keypad backlight flickers at dusk",
      description: "The capacitive keypad backlight flickers when ambient light is low.",
      status: "in_progress",
    })
    .onConflictDoNothing();
  await db
    .insert(task)
    .values({
      id: B.task,
      workspaceId: WS_B,
      issueId: B.issue,
      title: "Add debounce to the keypad backlight driver",
      state: "ready",
      agentProfileId: B.agent,
      executorProfileId: B.executor,
      repositoryId: B.repo,
      baseRef: "main",
    })
    .onConflictDoNothing();

  return { workspaceIds: [WS_A, WS_B] };
}

// CLI entry: `bun run src/seed.ts` (wired as `db:seed`). Uses the configured store.
if (import.meta.main) {
  const { createDb } = await import("./index.js");
  const result = await seed(createDb());
  console.log(`seeded workspaces: ${result.workspaceIds.join(", ")}`);
}
