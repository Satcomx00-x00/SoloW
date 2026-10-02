/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `0042` applied to a database that already holds catalog rows.
 *
 * `createTestDb` proves the migration applies to an empty database; what can actually go wrong is
 * the backfill — pinning a row that is not opencode's, or overwriting a pin or hint a Workspace
 * already chose. Applied by hand, as `migration.test.ts` does, so the rows can be written the way
 * the schema before it held them.
 */

/** What 0042 wrote, verbatim — history, so not read from today's defaults. */
const OPENCODE_1_HINT =
  "SoloW installs opencode-ai@1.18.33 itself: reinstall its dependencies (bun install from source, or npx @satcomx00-x00/solow@latest)";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const TARGET = "0042";

function journalTags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
}

function apply(db: Database, tag: string): void {
  const sql = readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

function databaseBeforeTarget(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const tag of journalTags()) {
    if (tag.startsWith(TARGET)) break;
    apply(db, tag);
  }
  return db;
}

function applyTarget(db: Database): void {
  const tag = journalTags().find((t) => t.startsWith(TARGET));
  if (!tag) throw new Error(`no ${TARGET} migration in the journal`);
  apply(db, tag);
}

function catalogRow(db: Database, id: string, key: string, installHint: string | null = null) {
  db.query(
    "INSERT INTO agent_catalog (id, workspace_id, key, display_name, protocol, command, install_hint, subscription_env_var, metered_env_var) VALUES (?, 'ws-1', ?, ?, 'acp', ?, ?, 'X_TOKEN', 'X_KEY')",
  ).run(id, key, key, key, installHint);
}

const read = (db: Database, id: string) =>
  db.query("SELECT min_version, install_hint FROM agent_catalog WHERE id = ?").get(id) as {
    min_version: string | null;
    install_hint: string | null;
  };

describe(`${TARGET}: the catalog's minimum version`, () => {
  it("pins every Workspace's existing opencode row to the build the defaults now seed", () => {
    const db = databaseBeforeTarget();
    db.exec("INSERT INTO workspace (id, name, owner_user_id) VALUES ('ws-1', 'Acme', 'owner-1')");
    catalogRow(db, "oc", "opencode");

    applyTarget(db);

    // The pin and hint the defaults seeded at the time; `0044` moves both to OpenCode 2, and
    // `opencode-2-migration.test.ts` checks the end state against today's defaults.
    expect(read(db, "oc")).toEqual({
      min_version: "1.18.33",
      install_hint: OPENCODE_1_HINT,
    });
  });

  it("leaves every other row unpinned — a pin is a claim about one harness", () => {
    const db = databaseBeforeTarget();
    db.exec("INSERT INTO workspace (id, name, owner_user_id) VALUES ('ws-1', 'Acme', 'owner-1')");
    catalogRow(db, "cc", "claude_code");
    catalogRow(db, "own", "my_harness", "brew install mine");

    applyTarget(db);

    expect(read(db, "cc")).toEqual({ min_version: null, install_hint: null });
    expect(read(db, "own")).toEqual({ min_version: null, install_hint: "brew install mine" });
  });

  it("keeps an install hint a Workspace already wrote on its opencode row", () => {
    const db = databaseBeforeTarget();
    db.exec("INSERT INTO workspace (id, name, owner_user_id) VALUES ('ws-1', 'Acme', 'owner-1')");
    catalogRow(db, "oc", "opencode", "our internal mirror: make opencode");

    applyTarget(db);

    expect(read(db, "oc").install_hint).toBe("our internal mirror: make opencode");
  });

  it("changes nothing when its backfill runs a second time", () => {
    const db = databaseBeforeTarget();
    db.exec("INSERT INTO workspace (id, name, owner_user_id) VALUES ('ws-1', 'Acme', 'owner-1')");
    catalogRow(db, "oc", "opencode");
    applyTarget(db);
    db.exec("UPDATE agent_catalog SET min_version = '2.0.0' WHERE id = 'oc'");

    // Only the guarded updates — the ALTER is not re-runnable, and is not meant to be.
    const sql = readFileSync(
      join(MIGRATIONS, `${journalTags().find((t) => t.startsWith(TARGET))}.sql`),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint").slice(1)) db.exec(statement);

    expect(read(db, "oc").min_version).toBe("2.0.0");
  });
});
