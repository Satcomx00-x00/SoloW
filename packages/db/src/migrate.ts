/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dbEnv } from "./env.js";

/**
 * Apply generated migrations to the configured SQLite file using Bun's built-in SQLite
 * (Decision 0008). Replaces `drizzle-kit migrate`, whose `better-sqlite3` native binding does
 * not build in this Bun-first toolchain. Migrations are still *generated* by drizzle-kit.
 */
export function runMigrations(): void {
  const env = dbEnv();
  const sqlite = new Database(env.GATECONTROL_SQLITE_PATH, { create: true });
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite);
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  migrate(db, { migrationsFolder });
  sqlite.close();
}

if (import.meta.main) {
  runMigrations();
  console.log("migrations applied");
}
