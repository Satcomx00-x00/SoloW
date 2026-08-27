/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Workflow migration applied to a database that already holds Tasks (issue #5).
 *
 * `createTestDb` proves the migration applies to an empty database, which is not the question
 * that costs anything if it is wrong. The question here is what happens to rows that were
 * written before Workflows existed: every one of them has to come out the other side unchanged
 * and following no Workflow, because that is what four NULL columns mean.
 */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** The tag of the migration under test — the one that adds `workflow` and `workflow_step`. */
const WORKFLOW_MIGRATION = "0013_swift_wind_dancer";

interface JournalEntry {
  idx: number;
  tag: string;
}

function journalTags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((entry) => entry.tag);
}

/**
 * Apply one migration file, statement by statement, with foreign keys off for the run — exactly
 * as `runMigrations` does, because drizzle rewrites a changed table by dropping and renaming.
 */
function apply(db: Database, tag: string): void {
  const sql = readFileSync(join(MIGRATIONS, `${tag}.sql`), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) db.exec(statement);
  }
}

/** A database migrated as far as the migration *before* this issue's. */
function databaseBeforeWorkflows(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = OFF;");
  for (const tag of journalTags()) {
    if (tag === WORKFLOW_MIGRATION) break;
    apply(db, tag);
  }
  return db;
}

/** The graph a Task needs to exist at all, plus two Tasks that predate Workflows entirely. */
function seedPopulated(db: Database): void {
  db.exec(
    "INSERT INTO workspace (id, name, owner_user_id) VALUES ('ws-1', 'Acme', 'owner-1'), ('ws-2', 'Other', 'owner-2')",
  );
  db.exec(
    "INSERT INTO repository (id, workspace_id, name, source, location) VALUES ('repo-1', 'ws-1', 'api', 'local_path', '/srv/api')",
  );
  db.exec("INSERT INTO issue (id, workspace_id, title) VALUES ('issue-1', 'ws-1', 'Ship it')");
  db.exec(
    "INSERT INTO agent_catalog (id, workspace_id, key, display_name, protocol, command, subscription_env_var, metered_env_var) VALUES ('cat-1', 'ws-1', 'claude_code', 'Claude Code', 'claude_code_stream_json', 'claude', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY')",
  );
  db.exec(
    "INSERT INTO agent_profile (id, workspace_id, name, agent_catalog_id, auth_mode, secret_id) VALUES ('ap-1', 'ws-1', 'claude', 'cat-1', 'api_key', 'sec-1')",
  );
  db.exec("INSERT INTO executor_profile (id, workspace_id, name) VALUES ('ep-1', 'ws-1', 'local')");
  for (const [id, state] of [
    ["task-open", "backlog"],
    ["task-done", "done"],
  ]) {
    db.query(
      `INSERT INTO task (id, workspace_id, issue_id, title, state, agent_profile_id, executor_profile_id)
       VALUES (?, 'ws-1', 'issue-1', 'Legacy task', ?, 'ap-1', 'ep-1')`,
    ).run(id as string, state as string);
  }
  db.exec(
    "INSERT INTO task_repository (id, workspace_id, task_id, repository_id, checkout_branch) VALUES ('tr-1', 'ws-1', 'task-open', 'repo-1', 'solow/task-task-open')",
  );
}

interface TaskRow {
  id: string;
  state: string;
  workflow_id: string | null;
  workflow_step_id: string | null;
  workflow_version: number | null;
  workflow_handoff: string | null;
}

describe("adding workflows to a database that already holds Tasks (issue #5)", () => {
  let db: Database;

  beforeEach(() => {
    db = databaseBeforeWorkflows();
    seedPopulated(db);
  });

  it("leaves every existing Task following no Workflow, and otherwise untouched", () => {
    const before = db.query("SELECT id, state, title FROM task ORDER BY id").all();

    apply(db, WORKFLOW_MIGRATION);

    const after = db.query("SELECT * FROM task ORDER BY id").all() as TaskRow[];
    expect(after.map((row) => ({ id: row.id, state: row.state, title: "Legacy task" }))).toEqual(
      before as { id: string; state: string; title: string }[],
    );
    for (const row of after) {
      expect(row.workflow_id).toBeNull();
      expect(row.workflow_step_id).toBeNull();
      expect(row.workflow_version).toBeNull();
      expect(row.workflow_handoff).toBeNull();
    }
  });

  it("leaves no dangling reference behind — the check runMigrations runs in production", () => {
    apply(db, WORKFLOW_MIGRATION);
    expect(db.query("PRAGMA foreign_key_check;").all()).toHaveLength(0);
    // The attachment seeded before the migration still resolves to its Task.
    expect(
      (
        db.query("SELECT count(*) AS n FROM task_repository WHERE task_id = 'task-open'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it("creates no Workflow for anyone — an empty list is the correct post-migration state", () => {
    apply(db, WORKFLOW_MIGRATION);
    expect((db.query("SELECT count(*) AS n FROM workflow").get() as { n: number }).n).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM workflow_step").get() as { n: number }).n).toBe(0);
  });

  it("makes the step order total, refusing two steps sharing a rank in one workflow", () => {
    apply(db, WORKFLOW_MIGRATION);
    db.exec("INSERT INTO workflow (id, workspace_id, name) VALUES ('wf-1', 'ws-1', 'Ship')");
    const insert = (id: string, rank: string) =>
      db
        .query(
          "INSERT INTO workflow_step (id, workspace_id, workflow_id, rank, name, agent_profile_id) VALUES (?, 'ws-1', 'wf-1', ?, 'Plan', 'ap-1')",
        )
        .run(id, rank);

    insert("st-1", "V");
    expect(() => insert("st-2", "V")).toThrow();
    // The same rank in a *different* Workflow is fine — the order is per pipeline.
    db.exec("INSERT INTO workflow (id, workspace_id, name) VALUES ('wf-2', 'ws-1', 'Other')");
    expect(() =>
      db.exec(
        "INSERT INTO workflow_step (id, workspace_id, workflow_id, rank, name, agent_profile_id) VALUES ('st-3', 'ws-1', 'wf-2', 'V', 'Plan', 'ap-1')",
      ),
    ).not.toThrow();
  });

  /**
   * The columns and the index that arrived after the tables did (migration 0014). Applied here
   * rather than in a file of their own because the question is the same one: what a database that
   * already holds Tasks looks like afterwards.
   */
  describe("the guards added on top of the Workflow tables", () => {
    beforeEach(() => {
      // The outer fixture stops just short of the Workflow tables; carry on from there to head.
      const tags = journalTags();
      for (const tag of tags.slice(tags.indexOf(WORKFLOW_MIGRATION))) apply(db, tag);
    });

    it("leaves a Task that predates them with nothing spent and nothing pending", () => {
      const rows = db
        .query("SELECT workflow_pending_handoff, workflow_decision_id FROM task ORDER BY id")
        .all() as {
        workflow_pending_handoff: string | null;
        workflow_decision_id: string | null;
      }[];
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.workflow_pending_handoff).toBeNull();
        expect(row.workflow_decision_id).toBeNull();
      }
    });

    it("serves the parked-cursor guard from an index rather than a scan of every Task", () => {
      // `deleteWorkflowStep` refuses while a Task's cursor sits on the Step, and asks that of the
      // whole `task` table on every Step edit. `task_workflow` cannot answer it — a prefix of
      // `(workspace_id, workflow_id)` says nothing about the cursor — so without its own index
      // this is a full Workspace scan for a check that matches at most a handful of rows.
      const plan = db
        .query(
          "EXPLAIN QUERY PLAN SELECT id FROM task WHERE workspace_id = 'ws-1' AND workflow_step_id = 'st-1'",
        )
        .all() as { detail: string }[];
      const detail = plan.map((row) => row.detail).join(" | ");
      expect(detail).toContain("task_workflow_step");
      expect(detail).not.toContain("SCAN task");
    });
  });

  it("refuses two Workflows sharing a name in one Workspace, and allows it across two", () => {
    apply(db, WORKFLOW_MIGRATION);
    db.exec("INSERT INTO workflow (id, workspace_id, name) VALUES ('wf-1', 'ws-1', 'Ship')");
    expect(() =>
      db.exec("INSERT INTO workflow (id, workspace_id, name) VALUES ('wf-2', 'ws-1', 'Ship')"),
    ).toThrow();
    expect(() =>
      db.exec("INSERT INTO workflow (id, workspace_id, name) VALUES ('wf-3', 'ws-2', 'Ship')"),
    ).not.toThrow();
  });
});
