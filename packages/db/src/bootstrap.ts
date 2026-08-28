import { ensureDefaultAgentCatalog } from "./agent-catalog-defaults.js";
import type { Db } from "./index.js";
import { workspace } from "./schema.js";

/**
 * Bring a database up to a usable *empty* Workspace (2026-08-28).
 *
 * What stood here was a fixture: two invented companies — Northwind Robotics and Harbor Freight
 * Automation — each with an invented credential, an Agent Profile pointing at it, an Executor
 * and a Repository at a path that never existed. It made a fresh install look configured when it
 * was not, and it hid the gap it was standing in front of: a Workspace created by a real sign-up
 * has no Secret, no Agent Profile and no Executor, and its feature flags are off, so the core
 * loop is disabled. Nobody saw that, because dev mode always landed on a Workspace where those
 * rows already existed and the flags were forced on.
 *
 * The setup checklist answers that question honestly now, from the rows that actually exist. So
 * the only things that must be true before anyone signs in are the two this creates: the
 * Workspace itself, and the agent catalog — reference data, not sample data, because without it
 * a brand-new Workspace could not name an agent at all.
 *
 * Idempotent: a fixed id and `onConflictDoNothing`, so re-running changes nothing. It is
 * deliberately *not* a place to add "helpful" starter rows — anything invented here is something
 * the checklist would then have to pretend it did not invent.
 */

/**
 * The single local install's Workspace.
 *
 * The id is the one the retired fixture used for its first Workspace, and it is kept on purpose:
 * every Issue, Task and Session already on disk in a local install references it, and changing it
 * would orphan all of them to make a name tidier.
 */
export const LOCAL_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/** Named for what it is until its Owner says otherwise — the checklist's first step is renaming it. */
const DEFAULT_WORKSPACE_NAME = "My workspace";

export interface BootstrapResult {
  workspaceId: string;
  /** False when the Workspace was already there — the CLI prints a different line for each. */
  created: boolean;
}

/**
 * Ensure the local Workspace and its agent catalog exist. Safe to run on every start.
 *
 * `ownerUserId` is a stand-in for the local single-Owner install, which has no sign-in: the
 * hosted path creates its Workspace in the sign-up hook instead, bound to a real account.
 */
export async function bootstrapWorkspace(
  db: Db,
  opts: { ownerUserId?: string; name?: string } = {},
): Promise<BootstrapResult> {
  const existing = await db.select({ id: workspace.id }).from(workspace).limit(1);

  await db
    .insert(workspace)
    .values({
      id: LOCAL_WORKSPACE_ID,
      name: opts.name ?? DEFAULT_WORKSPACE_NAME,
      ownerUserId: opts.ownerUserId ?? "local-owner",
      // Left at the registry default (OFF), like every other Workspace. Turning the core loop on
      // is a deliberate act, and the checklist is where it is made — not a side effect of the
      // database existing (constitution: feature flags).
      enabledFlags: null,
    })
    .onConflictDoNothing();

  await ensureDefaultAgentCatalog(db, LOCAL_WORKSPACE_ID);

  return { workspaceId: LOCAL_WORKSPACE_ID, created: existing.length === 0 };
}

// CLI entry: `bun run src/bootstrap.ts` (wired as `db:bootstrap`). Uses the configured store.
if (import.meta.main) {
  const { createDb } = await import("./index.js");
  const result = await bootstrapWorkspace(createDb());
  console.log(
    result.created
      ? `created workspace ${result.workspaceId}`
      : `workspace ${result.workspaceId} already present`,
  );
}
