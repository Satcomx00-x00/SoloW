/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Migrations applied to a database that already holds rows (issue #7 AC-6).
 *
 * Every other suite runs migrations against an empty database via `createTestDb`, which proves
 * they apply cleanly and nothing else. The question this file asks is the one that actually
 * costs data if it is wrong: a Task written under the old singular columns has to come out the
 * other side of `0010`/`0011` as a Task with exactly one attachment naming the same Repository.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

interface JournalEntry {
  idx: number;
  tag: string;
}

/** The migration tags in journal order — the same order `drizzle-kit`'s migrator applies them. */
function journalTags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
}

/**
 * Apply one migration file, statement by statement.
 *
 * Applied by hand rather than through drizzle's migrator because the point of this suite is to
 * stop *between* two migrations and write rows the way the old schema did. `PRAGMA foreign_keys`
 * is left off for the whole run, exactly as `runMigrations` does it: drizzle rewrites a changed
 * table by dropping and renaming, and the drop trips enforcement on a database that already
 * holds referencing rows.
 */
function apply(db: Database, tag: string): void {
  const sql = readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

/** A database migrated as far as `0009` — the shape that existed before this issue. */
function databaseAt0009(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const tag of journalTags()) {
    if (tag.startsWith("0010") || tag.startsWith("0011")) break;
    apply(db, tag);
  }
  return db;
}

function migrateToHead(db: Database): void {
  for (const tag of journalTags()) {
    if (!tag.startsWith("0010") && !tag.startsWith("0011")) continue;
    apply(db, tag);
  }
}

/** The graph a Task needs to exist at all, under the pre-0010 schema. */
function seedLegacyGraph(db: Database): void {
  db.exec(
    "INSERT INTO workspace (id, name, owner_user_id) VALUES ('ws-1', 'Acme', 'owner-1'), ('ws-2', 'Other', 'owner-2')",
  );
  db.exec(
    "INSERT INTO repository (id, workspace_id, name, source, location) VALUES ('repo-1', 'ws-1', 'api', 'local_path', '/srv/api'), ('repo-2', 'ws-2', 'lib', 'local_path', '/srv/lib')",
  );
  db.exec("INSERT INTO issue (id, workspace_id, title) VALUES ('issue-1', 'ws-1', 'Ship it')");
  db.exec(
    "INSERT INTO agent_catalog (id, workspace_id, key, display_name, protocol, command, subscription_env_var, metered_env_var) VALUES ('cat-1', 'ws-1', 'claude_code', 'Claude Code', 'claude_code_stream_json', 'claude', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY')",
  );
  db.exec(
    "INSERT INTO agent_profile (id, workspace_id, name, agent_catalog_id, auth_mode, secret_id) VALUES ('ap-1', 'ws-1', 'claude', 'cat-1', 'api_key', 'sec-1')",
  );
  db.exec("INSERT INTO executor_profile (id, workspace_id, name) VALUES ('ep-1', 'ws-1', 'local')");
}

function insertLegacyTask(
  db: Database,
  values: { id: string; baseRef: string | null; resultBranch: string | null },
): void {
  db.query(
    `INSERT INTO task (id, workspace_id, issue_id, title, state, agent_profile_id, executor_profile_id, repository_id, base_ref, result_branch)
     VALUES (?, 'ws-1', 'issue-1', 'Legacy task', 'backlog', 'ap-1', 'ep-1', 'repo-1', ?, ?)`,
  ).run(values.id, values.baseRef, values.resultBranch);
}

interface AttachmentRow {
  id: string;
  workspace_id: string;
  task_id: string;
  repository_id: string;
  base_ref: string | null;
  checkout_branch: string;
  result_branch: string | null;
  position: number;
}

function attachmentsFor(db: Database, taskId: string): AttachmentRow[] {
  return db.query("SELECT * FROM task_repository WHERE task_id = ?").all(taskId) as AttachmentRow[];
}

describe("migrating a populated database to the (repository, branch) join (issue #7 AC-6)", () => {
  let db: Database;

  beforeEach(() => {
    db = databaseAt0009();
    seedLegacyGraph(db);
  });

  it("gives every existing Task exactly one attachment naming the same Repository", () => {
    insertLegacyTask(db, { id: "task-a", baseRef: "main", resultBranch: null });
    insertLegacyTask(db, { id: "task-b", baseRef: null, resultBranch: null });
    const before = db.query("SELECT count(*) AS n FROM task").get() as { n: number };

    migrateToHead(db);

    const after = db.query("SELECT count(*) AS n FROM task_repository").get() as { n: number };
    expect(after.n).toBe(before.n);
    for (const taskId of ["task-a", "task-b"]) {
      const rows = attachmentsFor(db, taskId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.repository_id).toBe("repo-1");
      expect(rows[0]?.workspace_id).toBe("ws-1");
      expect(rows[0]?.position).toBe(0);
    }
  });

  it("carries the Task's base ref across verbatim, null included", () => {
    // Null meant HEAD on the Task and still means HEAD on the attachment — coercing it to a
    // literal branch name here would silently re-point every Task that never named a base.
    insertLegacyTask(db, { id: "task-named", baseRef: "release/2.1", resultBranch: null });
    insertLegacyTask(db, { id: "task-head", baseRef: null, resultBranch: null });

    migrateToHead(db);

    expect(attachmentsFor(db, "task-named")[0]?.base_ref).toBe("release/2.1");
    expect(attachmentsFor(db, "task-head")[0]?.base_ref).toBeNull();
  });

  it("keeps a finished Task pointing at the branch its work is actually on", () => {
    // A Task that finished under `claude_code` sits on a branch the *agent* named, which is not
    // the one SoloW derives. Preferring the recorded result branch is what keeps the
    // attachment pointing at something a reviewer can fetch.
    insertLegacyTask(db, {
      id: "task-done",
      baseRef: "main",
      resultBranch: "solow-task-task-done",
    });

    migrateToHead(db);

    const row = attachmentsFor(db, "task-done")[0];
    expect(row?.checkout_branch).toBe("solow-task-task-done");
    expect(row?.result_branch).toBe("solow-task-task-done");
  });

  it("derives the branch the next launch will ask git for when none was recorded", () => {
    insertLegacyTask(db, { id: "task-open", baseRef: null, resultBranch: null });

    migrateToHead(db);

    const row = attachmentsFor(db, "task-open")[0];
    expect(row?.checkout_branch).toBe("solow/task-task-open");
    expect(row?.result_branch).toBeNull();
  });

  it("leaves no dangling reference behind — the check runMigrations runs in production", () => {
    insertLegacyTask(db, { id: "task-fk", baseRef: "main", resultBranch: null });
    db.exec(
      "INSERT INTO session (id, workspace_id, task_id, state) VALUES ('sess-1', 'ws-1', 'task-fk', 'active')",
    );

    migrateToHead(db);

    // `__new_task` copies `id` unchanged, so every foreign key pointing at `task` — the session
    // above, and the attachment 0010 just wrote — still resolves after the rebuild.
    expect(db.query("PRAGMA foreign_key_check;").all()).toHaveLength(0);
    expect(
      (
        db.query("SELECT count(*) AS n FROM session WHERE task_id = 'task-fk'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it("drops the singular columns, so nothing can read them again", () => {
    insertLegacyTask(db, { id: "task-drop", baseRef: "main", resultBranch: null });

    migrateToHead(db);

    const columns = (db.query("PRAGMA table_info(task);").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).not.toContain("repository_id");
    expect(columns).not.toContain("base_ref");
    expect(columns).not.toContain("result_branch");
  });

  it("applies to a database with no Tasks at all without inserting anything", () => {
    migrateToHead(db);

    expect((db.query("SELECT count(*) AS n FROM task_repository").get() as { n: number }).n).toBe(
      0,
    );
  });
});
