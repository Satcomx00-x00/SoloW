import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ensureDefaultHarnessCatalog } from "./harness-catalog-defaults.js";
import type { Db } from "./index.js";
import { ensureDefaultLibraries } from "./library-defaults.js";
import { workspace } from "./schema.js";
import { ensureDefaultWorkflows } from "./workflow-defaults.js";

/**
 * Bring a database up to a usable *empty* Workspace (2026-08-28).
 *
 * What stood here was a fixture: two invented companies — Northwind Robotics and Harbor Freight
 * Automation — each with an invented credential, a Harness Profile pointing at it, an Executor
 * and a Repository at a path that never existed. It made a fresh install look configured when it
 * was not, and it hid the gap it was standing in front of: a Workspace created by a real sign-up
 * has no Secret, no Harness Profile and no Executor, and its feature flags are off, so the core
 * loop is disabled. Nobody saw that, because dev mode always landed on a Workspace where those
 * rows already existed and the flags were forced on.
 *
 * The setup checklist answers that question honestly now, from the rows that actually exist. So
 * the only things that must be true before anyone signs in are the two this creates: the
 * Workspace itself, and the harness catalog — reference data, not sample data, because without it
 * a brand-new Workspace could not name a harness at all.
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

/**
 * Who owns the local Workspace before anyone has signed up: a stand-in, not an account. Dev-owner
 * mode acts as this user, and the first real sign-up takes the Workspace over from it
 * (`provisionOwnerWorkspace`).
 */
export const LOCAL_OWNER_ID = "local-owner";

/** Named for what it is until its Owner says otherwise — the checklist's first step is renaming it. */
const DEFAULT_WORKSPACE_NAME = "My workspace";

/**
 * The reference rows every Workspace starts with, however it came to exist: the harness catalog,
 * and the libraries' and designer's starting content (specs F24, F03). Each seeds only into a
 * Workspace that has none of its own yet, so this is safe to run again.
 */
export async function seedWorkspaceDefaults(db: Db, workspaceId: string): Promise<void> {
  await ensureDefaultHarnessCatalog(db, workspaceId);
  await ensureDefaultLibraries(db, workspaceId);
  await ensureDefaultWorkflows(db, workspaceId);
}

/**
 * The Workspace a newly signed-up Owner gets. Run from the sign-up hook.
 *
 * The local Workspace, when bootstrap made it and nobody has claimed it yet: that is where
 * everything a local install already holds lives, and an Owner handed a fresh Workspace instead
 * would sign in to an empty board with their work in one they cannot reach. The claim is a single
 * conditional `UPDATE … WHERE owner = LOCAL_OWNER_ID`, so it is atomic on its own — two sign-ups
 * cannot both win it, and a Workspace a real account already owns is never taken.
 *
 * Otherwise a new one, seeded exactly as bootstrap seeds the local one.
 */
export async function provisionOwnerWorkspace(
  db: Db,
  owner: { id: string; name?: string | null; email: string },
): Promise<string> {
  const claimed = await db
    .update(workspace)
    .set({ ownerUserId: owner.id })
    .where(and(eq(workspace.id, LOCAL_WORKSPACE_ID), eq(workspace.ownerUserId, LOCAL_OWNER_ID)))
    .returning({ id: workspace.id });
  let workspaceId = claimed[0]?.id;
  if (!workspaceId) {
    workspaceId = randomUUID();
    await db.insert(workspace).values({
      id: workspaceId,
      name: `${owner.name || owner.email}'s workspace`,
      ownerUserId: owner.id,
      // Flags stay at their registry default for a new Workspace (constitution: feature flags).
      enabledFlags: null,
    });
  }
  await seedWorkspaceDefaults(db, workspaceId);
  return workspaceId;
}

export interface BootstrapResult {
  workspaceId: string;
  /** False when the Workspace was already there — the CLI prints a different line for each. */
  created: boolean;
}

/**
 * Ensure the local Workspace and its harness catalog exist. Safe to run on every start.
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
      ownerUserId: opts.ownerUserId ?? LOCAL_OWNER_ID,
      // Left at the registry default (OFF), like every other Workspace. Turning the core loop on
      // is a deliberate act, and the checklist is where it is made — not a side effect of the
      // database existing (constitution: feature flags).
      enabledFlags: null,
    })
    .onConflictDoNothing();

  await seedWorkspaceDefaults(db, LOCAL_WORKSPACE_ID);

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
