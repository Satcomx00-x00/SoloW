/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HARNESS_CATALOG } from "./harness-catalog-defaults.js";

/**
 * `0046` applied to a database whose opencode rows still launch plain `acp`: every row that kept
 * the seeded arguments gets `--auto`, the arguments a fresh Workspace is seeded with, and nothing a
 * Workspace chose for itself — nor any other harness — is touched.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const TARGET = "0046";

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
  db.exec("INSERT INTO workspace (id, name, owner_user_id) VALUES ('ws-1', 'Acme', 'owner-1')");
  return db;
}

const target = (db: Database) => apply(db, tags().find((t) => t.startsWith(TARGET)) as string);

const row = (db: Database, id: string, key: string, args: string[]) =>
  db
    .query(
      "INSERT INTO agent_catalog (id, workspace_id, key, display_name, protocol, command, args_template, subscription_env_var, metered_env_var) VALUES (?, 'ws-1', ?, ?, 'acp', ?, ?, 'X_TOKEN', 'X_KEY')",
    )
    .run(id, key, key, key, JSON.stringify(args));

const args = (db: Database, id: string) =>
  JSON.parse(
    (
      db.query("SELECT args_template FROM agent_catalog WHERE id = ?").get(id) as {
        args_template: string;
      }
    ).args_template,
  ) as string[];

describe(`${TARGET}: opencode --auto`, () => {
  it("gives a seeded opencode row the arguments a fresh Workspace gets", () => {
    const db = before();
    row(db, "oc", "opencode", ["acp"]);
    target(db);
    const seeded = DEFAULT_HARNESS_CATALOG.find((r) => r.key === "opencode");
    expect(args(db, "oc")).toEqual(seeded?.argsTemplate ?? []);
    expect(args(db, "oc")).toEqual(["acp", "--auto"]);
  });

  it("keeps arguments a Workspace chose, and every other harness", () => {
    const db = before();
    row(db, "own", "opencode", ["acp", "--log-level", "debug"]);
    row(db, "other", "my_harness", ["acp"]);
    target(db);
    expect(args(db, "own")).toEqual(["acp", "--log-level", "debug"]);
    expect(args(db, "other")).toEqual(["acp"]);
  });

  it("is safe to apply twice", () => {
    const db = before();
    row(db, "oc", "opencode", ["acp"]);
    target(db);
    target(db);
    expect(args(db, "oc")).toEqual(["acp", "--auto"]);
  });
});
