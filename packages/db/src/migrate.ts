/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { backupBeforeMigrate } from "./backup.js";
import { dbEnv } from "./env.js";

const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/**
 * Apply generated migrations to the configured SQLite file using Bun's built-in SQLite
 * (Decision 0008). Replaces `drizzle-kit migrate`, whose `better-sqlite3` native binding does
 * not build in this Bun-first toolchain. Migrations are still *generated* by drizzle-kit.
 */
export function runMigrations(): void {
  const env = dbEnv();
  const sqlite = new Database(env.SOLOW_SQLITE_PATH, { create: true });
  // Foreign keys stay OFF for the duration of the migration: drizzle-kit rewrites a changed
  // table by building `__new_<table>`, copying rows, dropping the original and renaming — and
  // the DROP trips enforcement on any database that already holds referencing rows (a fresh
  // one has none, which is why CI never saw this). The pragma is a no-op inside a transaction,
  // so it has to be set here rather than around `migrate`. `foreign_key_check` afterwards
  // makes sure the migration did not actually leave a dangling reference behind.
  sqlite.exec("PRAGMA foreign_keys = OFF;");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const violations = sqlite.query("PRAGMA foreign_key_check;").all();
  if (violations.length > 0) {
    sqlite.close();
    throw new Error(
      `migrations left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`,
    );
  }
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.close();
}

/**
 * `bun run db:migrate` from a shell that is not `scripts/dev.sh`. `dbEnv()` validates the
 * whole DB env, `SOLOW_SECRET_KEY` included — a migration touches no encrypted column, but the
 * schema module reads the same env — so the bare command died on a Zod error before doing
 * anything. The same fallback `scripts/flag.ts` uses: the key dev.sh generated, and the
 * database dev.sh points at, only when the operator has not set either (a deployment always
 * has). `SOLOW_SQLITE_PATH` matters as much as the key: the default is relative to the working
 * directory, and `bun run --filter @solow/db` runs from `packages/db`, where a silent default
 * would have migrated a brand-new, empty database beside the source.
 */
function loadDevEnv(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  if (!process.env.SOLOW_SQLITE_PATH) {
    process.env.SOLOW_SQLITE_PATH = join(root, ".solow", "solow.db");
  }
  if (process.env.SOLOW_SECRET_KEY) return;
  const keyFile = join(root, ".solow", "dev-secret.key");
  if (!existsSync(keyFile)) {
    console.error(
      `SOLOW_SECRET_KEY is not set and ${keyFile} does not exist.\n` +
        "Start the stack once with `bun run dev` to generate it, or export the key yourself.",
    );
    process.exit(1);
  }
  process.env.SOLOW_SECRET_KEY = readFileSync(keyFile, "utf8").trim();
}

if (import.meta.main) {
  loadDevEnv();
  // The safety net for an upgrade (FINDINGS F1): a consistent copy of the database, and the keys
  // that read it, before the first statement that changes its schema. Here rather than inside
  // `runMigrations`, which tests call on scratch databases; this is the entry point every
  // launcher runs. A copy that cannot be taken stops the migration — upgrading without the net
  // is the thing this exists to prevent.
  const copy = backupBeforeMigrate(dbEnv().SOLOW_SQLITE_PATH, MIGRATIONS_FOLDER);
  if (copy) console.log(`backed up the database to ${copy} before migrating`);
  runMigrations();
  console.log(`migrations applied to ${process.env.SOLOW_SQLITE_PATH}`);
}
