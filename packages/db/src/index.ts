/// <reference types="bun-types" />
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { dbEnv } from "./env.js";
import { allTables } from "./tables.js";

/**
 * Driver selection for the single data model (Decision 0008).
 * v1 ships the SQLite (local) driver using Bun's built-in SQLite. The Postgres (hosted)
 * driver is a follow-up that reuses the same conceptual schema — see the note in schema.ts.
 */
/**
 * The process's one connection.
 *
 * This used to open a fresh `Database` on every call, and every call is a *request*: the tRPC
 * context builds one, the signed-in layout builds another, the MCP handler a third. Each one
 * paid for opening the file, re-running the pragmas, and — the part that actually costs — threw
 * away SQLite's prepared-statement cache, so no query in this app was ever compiled once. A
 * handle is also where WAL's read snapshot and the page cache live; discarding it per request
 * discards both.
 *
 * Safe to share because the path cannot change under it: `dbEnv()` parses the environment once
 * per process and caches it, so a second call could only ever have opened the same file. Bun's
 * SQLite handle is safe to use concurrently, and WAL is what lets the orchestrator's writes and
 * the web app's reads proceed without blocking each other.
 *
 * Tests never come through here — they build their own database from `@solow/db/testing`.
 */
let connection: ReturnType<typeof openDb> | undefined;

function openDb(path: string) {
  const sqlite = new Database(path, { create: true });
  // Readers never block the writer and the writer never blocks readers. Non-negotiable here:
  // the orchestrator writes on its poll while the operator is reading a table.
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  // With WAL, `NORMAL` stops fsyncing on every commit and syncs at checkpoints instead. The
  // failure it admits is losing the last transactions to an OS-level crash or power loss — not
  // to a process crash, which WAL still survives intact. That is the right trade for a local
  // work-tracking mirror whose rows are re-derivable from the provider on the next poll, and it
  // is the difference between a write costing a disk sync and costing a memcpy.
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  // Two processes share this file. Without a busy timeout, the loser of a write race gets
  // SQLITE_BUSY immediately and surfaces it as a failed mutation; with one, it waits out the
  // other's transaction, which on a local file is milliseconds.
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  // ~64 MB of page cache (negative means KiB rather than pages). The whole working set of a
  // local install fits, so reads stop touching the file at all after the first pass.
  sqlite.exec("PRAGMA cache_size = -65536;");
  // Sorts and the temporary B-trees behind GROUP BY / DISTINCT stay in memory rather than
  // being spilled to disk.
  sqlite.exec("PRAGMA temp_store = MEMORY;");
  return drizzle(sqlite, { schema: allTables });
}

export function createDb() {
  const env = dbEnv();
  if (env.SOLOW_DB_DRIVER === "postgres") {
    throw new Error(
      "Postgres driver is not wired in v1 — set SOLOW_DB_DRIVER=sqlite (Decision 0008 follow-up).",
    );
  }
  connection ??= openDb(env.SOLOW_SQLITE_PATH);
  return connection;
}

export type Db = ReturnType<typeof createDb>;

export { ensureDefaultAgentCatalog } from "./agent-catalog-defaults.js";
export * from "./auth-schema.js";
export { bootstrapWorkspace, LOCAL_WORKSPACE_ID } from "./bootstrap.js";
export { dbEnv } from "./env.js";
export {
  FLAGS,
  type FlagContext,
  type FlagDefinition,
  type FlagKey,
  flagKeys,
  isEnabled,
  isFlagKey,
} from "./flag-registry.js";
export { listWorkspaceFlags, setWorkspaceFlag, type WorkspaceFlags } from "./flags.js";
export {
  type GeneratedMcpToken,
  generateMcpToken,
  hashMcpToken,
  mcpTokenHashEquals,
} from "./mcp-token-store.js";
export {
  addIssueToProject,
  attachIssueToLocalProjects,
  backfillProjectFromRepository,
} from "./project-membership.js";
export * from "./schema.js";
export { schema } from "./schema.js";
export { decryptForAgentRun, decryptForScmSync, encryptSecret } from "./secret-store.js";
export { allTables } from "./tables.js";
export {
  advanceTaskWorkflow,
  clearTaskWorkflowPendingHandoff,
  loadTaskWorkflowRun,
  stepsToDto,
  stepToDto,
} from "./workflow-run.js";
