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
export function createDb() {
  const env = dbEnv();
  if (env.GATECONTROL_DB_DRIVER === "postgres") {
    throw new Error(
      "Postgres driver is not wired in v1 — set GATECONTROL_DB_DRIVER=sqlite (Decision 0008 follow-up).",
    );
  }
  const sqlite = new Database(env.GATECONTROL_SQLITE_PATH, { create: true });
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  return drizzle(sqlite, { schema: allTables });
}

export type Db = ReturnType<typeof createDb>;

export { ensureDefaultAgentCatalog } from "./agent-catalog-defaults.js";
export * from "./auth-schema.js";
export { dbEnv } from "./env.js";
export { listWorkspaceFlags, setWorkspaceFlag, type WorkspaceFlags } from "./flags.js";
export * from "./schema.js";
export { schema } from "./schema.js";
export { decryptForAgentRun, encryptSecret } from "./secret-store.js";
export { SEED_WORKSPACE_A, SEED_WORKSPACE_B, seed } from "./seed.js";
export { allTables } from "./tables.js";
