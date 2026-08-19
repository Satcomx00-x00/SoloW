import "server-only";
import { type Db, workspace } from "@gatecontrol/db";
import { eq } from "drizzle-orm";
import { FLAGS, type FlagKey } from "../flags.js";

/**
 * Workspace-level reads used before a `RequestContext` exists — the flag overrides are needed to
 * build the request context itself, so this one takes the db and the tenant key directly.
 */

/**
 * Feature-flag overrides stored on the Workspace (task TASK-001). Absent or malformed JSON
 * yields no overrides, so the registry default (OFF) stands — a corrupt column must never be
 * read as "the feature is on".
 */
export async function getWorkspaceFlags(
  db: Db,
  workspaceId: string,
): Promise<Partial<Record<FlagKey, boolean>>> {
  const [row] = await db
    .select({ enabledFlags: workspace.enabledFlags })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);

  const raw = row?.enabledFlags;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  // Validated against the flag registry rather than a hardcoded key. The previous version named
  // `ff-core-program` literally, which silently dropped every later flag — `ff-integrations`
  // (issue #15) could be set in this column and would still read as OFF. Driving the check off
  // FLAGS means registering a flag is the only step needed for it to be readable here.
  const overrides: Partial<Record<FlagKey, boolean>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key in FLAGS && typeof value === "boolean") overrides[key as FlagKey] = value;
  }
  return overrides;
}

/** The Workspace's display name, for the shell. Null when the row has gone. */
export async function getWorkspaceName(db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: workspace.name })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return row?.name ?? null;
}
