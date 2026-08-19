import { eq } from "drizzle-orm";
import type { Db } from "./index.js";
import { workspace } from "./schema.js";

/**
 * Feature-flag persistence (task TASK-001). Flags live on the Workspace row and default to OFF;
 * these are the only writers, so the operator script and anything else that flips a flag agree
 * on the shape stored there.
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
