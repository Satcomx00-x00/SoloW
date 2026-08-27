/// <reference types="bun-types" />
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  FLAGS,
  flagKeys,
  isFlagKey,
  listWorkspaceFlags,
  setWorkspaceFlag,
} from "@solow/db";

/**
 * Turn a feature flag on or off for a Workspace, from the machine that runs the instance.
 *
 *   bun run flag list
 *   bun run flag enable  ff-core-program [workspaceId]
 *   bun run flag disable ff-core-program [workspaceId]
 *
 * With no workspaceId the change applies to every Workspace — the single-Owner local case.
 *
 * Settings now carries a flag toggle too (issue #21), so this is no longer the only way to flip
 * one. It remains the way that does not depend on the app: `ff-core-program` gates most of the
 * API, so once it is off the UI that would turn it back on may itself be out of reach — this is
 * the recovery path out of that. It is also the only way to target a Workspace other than the
 * caller's own, which the router deliberately does not expose.
 *
 * The set of flags comes from `@solow/db`'s registry, never a list kept here: a local copy
 * went stale and started rejecting flags the UI was already offering.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `createDb()` validates the whole DB env up front, `SOLOW_SECRET_KEY` included — even
 * though flipping a flag touches no encrypted column. That key is exported by `scripts/dev.sh`
 * for the services it starts, so running this script on its own would otherwise die on a Zod
 * error before doing anything. Read the same file dev.sh generates, and only when the operator
 * has not set the variable themselves (a real deployment always has).
 */
function loadDevSecretKey(): void {
  if (process.env.SOLOW_SECRET_KEY) return;
  const keyFile = join(ROOT, ".solow", "dev-secret.key");
  if (!existsSync(keyFile)) {
    console.error(
      `SOLOW_SECRET_KEY is not set and ${keyFile} does not exist.\n` +
        "Start the stack once with `bun run dev` to generate it, or export the key yourself.",
    );
    process.exit(1);
  }
  process.env.SOLOW_SECRET_KEY = readFileSync(keyFile, "utf8").trim();
}

function usage(message: string): never {
  console.error(`${message}

Usage:
  bun run flag list
  bun run flag enable  <flag> [workspaceId]
  bun run flag disable <flag> [workspaceId]

Flags:
${flagKeys()
  .map((key) => `  ${key.padEnd(18)} ${FLAGS[key].description}`)
  .join("\n")}`);
  process.exit(1);
}

const [command, flag, workspaceId] = process.argv.slice(2);

if (command !== "list" && command !== "enable" && command !== "disable") {
  usage(`Unknown command: ${command ?? "(none given)"}`);
}
if ((command === "enable" || command === "disable") && (!flag || !isFlagKey(flag))) {
  usage(`Unknown flag: ${flag ?? "(none given)"}`);
}

loadDevSecretKey();
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
} else {
  const changed = await setWorkspaceFlag(db, flag as string, command === "enable", workspaceId);
  if (changed.length === 0) usage(`No workspace matched ${workspaceId ?? "(any)"}.`);
  for (const row of changed) {
    console.log(`${command}d ${flag} for ${row.name} (${row.id})`);
  }
}
