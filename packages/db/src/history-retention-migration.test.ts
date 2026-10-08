/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HISTORY_RETENTION_DEFAULT_DAYS } from "@solow/contracts";

/**
 * `0049` applied to an install that already has Workspaces (Decision 0032 §4): nothing an Owner
 * already has is put on a clock they never saw. An existing Workspace keeps every transcript
 * (null) and is flagged so Settings can ask; a Workspace created afterwards starts on the default
 * window, unflagged, because it was told the rule from its first day.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const TARGET = "0049";

const tags = (): string[] =>
  (
    JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    }
  ).entries
    .sort((a, b) => a.idx - b.idx)
    .map((e) => e.tag);

const apply = (db: Database, tag: string): void => {
  for (const statement of readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8").split(
    "--> statement-breakpoint",
  )) {
    if (statement.trim()) db.exec(statement);
  }
};

function before(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const tag of tags()) {
    if (tag.startsWith(TARGET)) break;
    apply(db, tag);
  }
  db.exec("INSERT INTO workspace (id, name, owner_user_id) VALUES ('old', 'Acme', 'owner-1')");
  return db;
}

const target = (db: Database) => apply(db, tags().find((t) => t.startsWith(TARGET)) as string);

const read = (db: Database, id: string) =>
  db
    .query(
      "SELECT history_retention_days AS days, history_retention_notice AS notice FROM workspace WHERE id = ?",
    )
    .get(id) as { days: number | null; notice: number };

describe(`${TARGET}: history retention on an existing install`, () => {
  it("keeps an existing Workspace's transcripts forever, and flags it for the Owner", () => {
    const db = before();
    target(db);
    expect(read(db, "old")).toEqual({ days: null, notice: 1 });
  });

  it("starts a Workspace created after the upgrade on the default window, unflagged", () => {
    const db = before();
    target(db);
    db.exec("INSERT INTO workspace (id, name, owner_user_id) VALUES ('new', 'Beta', 'owner-2')");
    expect(read(db, "new")).toEqual({ days: HISTORY_RETENTION_DEFAULT_DAYS, notice: 0 });
  });
});
