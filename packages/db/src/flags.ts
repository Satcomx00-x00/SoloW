import { eq } from "drizzle-orm";
import { flagKeys } from "./flag-registry.js";
import type { Db } from "./index.js";
import { workspace } from "./schema.js";

/**
 * Feature-flag persistence (task TASK-001). Flags live on the Workspace row and default to ON
 * (constitution v1.5.0); these are the only writers, so the operator script and anything else
 * that flips a flag agree on the shape stored there.
 *
 * The column holds an explicit `true`/`false` per flag, never a list of enabled names, and that
 * is what keeps the kill switch expressible now that absence means enabled: a Workspace with no
 * row at all reads every flag at its registry default, and turning one off is a stored `false`
 * rather than the removal of an entry.
 */

export interface WorkspaceFlags {
  id: string;
  name: string;
  flags: Record<string, boolean>;
}

export async function listWorkspaceFlags(db: Db): Promise<WorkspaceFlags[]> {
  const rows = await db
    .select({ id: workspace.id, name: workspace.name, flags: workspace.enabledFlags })
    .from(workspace);
  return rows.map((row) => ({ id: row.id, name: row.name, flags: row.flags ?? {} }));
}

/**
 * Turn one flag on or off for a Workspace, leaving any other flags on that row alone.
 * Returns the Workspaces changed — empty when `workspaceId` matched nothing.
 */
export async function setWorkspaceFlag(
  db: Db,
  flag: string,
  enabled: boolean,
  workspaceId?: string,
): Promise<WorkspaceFlags[]> {
  const all = await listWorkspaceFlags(db);
  const targets = workspaceId ? all.filter((w) => w.id === workspaceId) : all;

  for (const target of targets) {
    await db
      .update(workspace)
      .set({ enabledFlags: { ...target.flags, [flag]: enabled } })
      .where(eq(workspace.id, target.id));
  }
  return targets;
}

/**
 * One Workspace's flags as a line an operator can read — its *effective* state, not its stored
 * keys.
 *
 * Here rather than inline in `scripts/flag.ts` so it can be tested: the script reads `argv` and
 * opens a database at import time, so nothing can import it to check what it prints. That
 * mattered the moment the default flipped — while flags defaulted OFF, "stored keys" and
 * "what is on" were the same list, and `bun run flag list` printed the stored ones. Afterwards a
 * fresh Workspace stores nothing and has everything on, and the unchanged line would have
 * answered "none enabled" to the one person who runs this command to find out what is enabled.
 *
 * Phrased as an exception list because that is the shape the answer now has: everything is on
 * unless somebody turned it off, so naming the exceptions is both shorter and the thing an
 * operator is actually looking for.
 */
export function describeWorkspaceFlags(flags: Record<string, boolean>): string {
  const off = flagKeys().filter((key) => flags[key] === false);
  return off.length === 0 ? "all on" : `all on except ${off.join(", ")}`;
}
