/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HARNESS_CATALOG } from "./harness-catalog-defaults.js";

/**
 * `0044` applied to a database whose opencode rows were pinned by `0042`: every Workspace that kept
 * the seeded 1.x pin and hint moves to the OpenCode 2 build SoloW now bundles, and nothing a
 * Workspace chose for itself is touched.
 */

/** What 0042 seeded, verbatim — the value 0044 recognises as "never customised". */
const OPENCODE_1_HINT =
  "SoloW installs opencode-ai@1.18.33 itself: reinstall its dependencies (bun install from source, or npx @satcomx00-x00/solow@latest)";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const TARGET = "0044";

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

const row = (db: Database, id: string, key: string, pin: string | null, hint: string | null) =>
  db
    .query(
      "INSERT INTO agent_catalog (id, workspace_id, key, display_name, protocol, command, min_version, install_hint, subscription_env_var, metered_env_var) VALUES (?, 'ws-1', ?, ?, 'acp', ?, ?, ?, 'X_TOKEN', 'X_KEY')",
    )
    .run(id, key, key, key, pin, hint);

const read = (db: Database, id: string) =>
  db.query("SELECT min_version, install_hint FROM agent_catalog WHERE id = ?").get(id);

describe(`${TARGET}: OpenCode 2`, () => {
  it("moves a seeded opencode row to the pin and hint a fresh Workspace gets", () => {
    const db = before();
    row(db, "oc", "opencode", "1.18.33", OPENCODE_1_HINT);
    target(db);
    const seeded = DEFAULT_HARNESS_CATALOG.find((r) => r.key === "opencode");
    expect(read(db, "oc")).toEqual({
      min_version: seeded?.minVersion ?? null,
      install_hint: seeded?.installHint ?? null,
    });
  });

  it("keeps a pin or hint the Workspace chose, and every other harness", () => {
    const db = before();
    row(db, "oc", "opencode", "1.20.0", "our mirror");
    row(db, "own", "my_harness", "1.18.33", OPENCODE_1_HINT);
    target(db);
    expect(read(db, "oc")).toEqual({ min_version: "1.20.0", install_hint: "our mirror" });
    expect(read(db, "own")).toEqual({ min_version: "1.18.33", install_hint: OPENCODE_1_HINT });
  });

  it("is safe to run twice", () => {
    const db = before();
    row(db, "oc", "opencode", "1.18.33", OPENCODE_1_HINT);
    target(db);
    const once = read(db, "oc");
    target(db);
    expect(read(db, "oc")).toEqual(once);
  });
});
