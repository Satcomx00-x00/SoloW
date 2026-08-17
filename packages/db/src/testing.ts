/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { schema } from "./schema.js";

/**
 * Test-only: an in-memory SQLite database with all migrations applied. Used by DAL and
 * orchestrator tests so each test gets an isolated, real database (constitution Principle VI).
 */
export function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  const db = drizzle(sqlite, { schema });
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  migrate(db, { migrationsFolder });
  return db;
}

export type TestDb = ReturnType<typeof createTestDb>;
