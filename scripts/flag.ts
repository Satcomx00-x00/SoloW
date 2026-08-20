/// <reference types="bun-types" />
import { createDb, listWorkspaceFlags, setWorkspaceFlag } from "@gatecontrol/db";

/**
 * Turn a feature flag on or off for a Workspace (task TASK-001 kill switch).
 *
 * Flags are an *operator* control, not a user setting: they ship OFF, and enabling the core loop
 * for a Workspace is a deliberate act taken from the machine that runs the instance. A toggle in
 * Settings would put the kill switch in reach of whoever is signed in, which is the opposite of
 * what a kill switch is for — hence a script rather than a UI.
 *
 *   bun run flag list
 *   bun run flag enable  ff-core-program [workspaceId]
 *   bun run flag disable ff-core-program [workspaceId]
 *
 * With no workspaceId the change applies to every Workspace — the single-Owner local case.
 */

const KNOWN_FLAGS = ["ff-core-program", "ff-workflows"] as const;

function usage(message: string): never {
  console.error(`${message}

Usage:
  bun run flag list
  bun run flag enable  <flag> [workspaceId]
  bun run flag disable <flag> [workspaceId]

Flags: ${KNOWN_FLAGS.join(", ")}`);
  process.exit(1);
}

const [command, flag, workspaceId] = process.argv.slice(2);
const db = createDb();

if (command === "list") {
  const rows = await listWorkspaceFlags(db);
  if (rows.length === 0) console.log("no workspaces yet");
  for (const row of rows) {
    const on = Object.entries(row.flags)
      .filter(([, enabled]) => enabled)
      .map(([key]) => key);
    console.log(`${row.id}  ${row.name}  [${on.join(", ") || "none enabled"}]`);
  }
} else if (command === "enable" || command === "disable") {
  if (!flag || !KNOWN_FLAGS.includes(flag as (typeof KNOWN_FLAGS)[number])) {
    usage(`Unknown flag: ${flag ?? "(none given)"}`);
  }
  const changed = await setWorkspaceFlag(db, flag, command === "enable", workspaceId);
  if (changed.length === 0) usage(`No workspace matched ${workspaceId ?? "(any)"}.`);
  for (const row of changed) {
    console.log(`${command}d ${flag} for ${row.name} (${row.id})`);
  }
} else {
  usage(`Unknown command: ${command ?? "(none given)"}`);
}
