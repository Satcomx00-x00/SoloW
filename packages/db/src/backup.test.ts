/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import {
  BACKUPS_DIR,
  BackupError,
  backupBeforeMigrate,
  backupDataDir,
  backupStamp,
  keepFromEnv,
  listBackups,
  MANIFEST_FILE,
  PID_FILE,
  pendingMigrations,
  pruneBackups,
  readManifest,
  restoreDataDir,
  runningStackPid,
} from "./backup.js";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "solow-backup-"));
  dirs.push(dir);
  return dir;
}

/** A data folder shaped like the one a launcher makes: a WAL database, keys, engine state. */
function dataFolder(rows: string[] = ["one"]): string {
  const dir = scratch();
  const db = new Database(join(dir, "solow.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE note (body TEXT NOT NULL);");
  for (const body of rows) db.query("INSERT INTO note (body) VALUES (?)").run(body);
  db.close();
  writeFileSync(join(dir, "secret.key"), "key-a\n");
  writeFileSync(join(dir, "orchestrator.secret"), "orch-a\n");
  writeFileSync(join(dir, "chrome-debug.log"), "not state\n");
  mkdirSync(join(dir, "inngest"));
  const engine = new Database(join(dir, "inngest", "main.db"), { create: true });
  engine.exec("CREATE TABLE run (id TEXT); INSERT INTO run VALUES ('run-a');");
  engine.close();
  return dir;
}

function notes(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT body FROM note ORDER BY rowid").all() as { body: string }[]).map(
      (row) => row.body,
    );
  } finally {
    db.close();
  }
}

const at = (iso: string) => new Date(iso);

describe("backupDataDir", () => {
  it("copies what a live writer committed into the WAL, and nothing it has not committed", () => {
    const dir = dataFolder([]);
    const writer = new Database(join(dir, "solow.db"));
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    writer.query("INSERT INTO note (body) VALUES ('committed')").run();
    writer.exec("BEGIN; INSERT INTO note (body) VALUES ('in flight');");

    // The bug a file copy has: the committed row lives only in `solow.db-wal` right now.
    const fileCopy = join(scratch(), "copy.db");
    copyFileSync(join(dir, "solow.db"), fileCopy);
    expect(notes(fileCopy)).toEqual([]);

    const backup = backupDataDir(dir, { now: at("2026-10-08T10:00:00Z") });
    writer.exec("ROLLBACK;");
    writer.close();
    expect(notes(join(backup, "solow.db"))).toEqual(["committed"]);
  });

  it("takes the keys and the engine state, and nothing else in the folder", () => {
    const dir = dataFolder();
    const backup = backupDataDir(dir, { now: at("2026-10-08T10:00:00Z") });

    expect(backup).toBe(join(dir, BACKUPS_DIR, "20261008T100000Z-manual"));
    expect(readFileSync(join(backup, "secret.key"), "utf8")).toBe("key-a\n");
    expect(existsSync(join(backup, "orchestrator.secret"))).toBe(true);
    expect(existsSync(join(backup, "chrome-debug.log"))).toBe(false);
    expect(existsSync(join(backup, "inngest", "main.db"))).toBe(true);
    expect(statSync(join(backup, "secret.key")).mode & 0o777).toBe(0o600);
    expect(readManifest(backup)).toEqual({
      format: 1,
      kind: "manual",
      createdAt: "2026-10-08T10:00:00.000Z",
      keys: ["secret.key", "orchestrator.secret"],
      engine: true,
    });
  });

  it("leaves the engine out when asked, and writes elsewhere when told to", () => {
    const dir = dataFolder();
    const out = scratch();
    const backup = backupDataDir(dir, { into: out, engine: false });
    expect(dirname(backup)).toBe(out);
    expect(existsSync(join(backup, "inngest"))).toBe(false);
    expect(readManifest(backup).engine).toBe(false);
  });

  it("never reuses a directory taken in the same second", () => {
    const dir = dataFolder();
    const now = at("2026-10-08T10:00:00Z");
    const first = backupDataDir(dir, { now });
    const second = backupDataDir(dir, { now });
    expect(second).toBe(`${first}-2`);
  });

  it("refuses a folder with no database, and leaves nothing behind", () => {
    const dir = scratch();
    expect(() => backupDataDir(dir)).toThrow(BackupError);
    expect(existsSync(join(dir, BACKUPS_DIR))).toBe(false);
  });
});

describe("listBackups and pruneBackups", () => {
  it("lists complete backups newest first, and skips one that never finished", () => {
    const dir = dataFolder();
    backupDataDir(dir, { now: at("2026-10-01T00:00:00Z") });
    backupDataDir(dir, { now: at("2026-10-03T00:00:00Z") });
    const unfinished = backupDataDir(dir, { now: at("2026-10-05T00:00:00Z") });
    rmSync(join(unfinished, MANIFEST_FILE));

    expect(listBackups(join(dir, BACKUPS_DIR)).map((entry) => entry.name)).toEqual([
      "20261003T000000Z-manual",
      "20261001T000000Z-manual",
    ]);
  });

  it("keeps the newest automatic copies of one kind and never touches manual ones", () => {
    const dir = dataFolder();
    const backups = join(dir, BACKUPS_DIR);
    for (const day of ["01", "02", "03", "04"]) {
      backupDataDir(dir, { kind: "pre-migrate", now: at(`2026-10-${day}T00:00:00Z`) });
    }
    backupDataDir(dir, { kind: "manual", now: at("2026-09-01T00:00:00Z") });

    pruneBackups(backups, "pre-migrate", 2);
    expect(listBackups(backups).map((entry) => entry.name)).toEqual([
      "20261004T000000Z-pre-migrate",
      "20261003T000000Z-pre-migrate",
      "20260901T000000Z-manual",
    ]);
    expect(pruneBackups(backups, "manual", 0)).toEqual([]);
  });

  it("reads the kept count from SOLOW_BACKUP_KEEP, falling back on nonsense", () => {
    expect(keepFromEnv("3")).toBe(3);
    expect(keepFromEnv(undefined)).toBe(5);
    expect(keepFromEnv("0")).toBe(5);
    expect(keepFromEnv("lots")).toBe(5);
  });

  it("stamps a name that sorts as it reads", () => {
    expect(backupStamp(at("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
  });
});

describe("restoreDataDir", () => {
  it("refuses while the stack is running on the folder, and changes nothing", () => {
    const dir = dataFolder(["current"]);
    const backup = backupDataDir(dir);
    writeFileSync(join(dir, PID_FILE), "4242\n");

    expect(() => restoreDataDir(dir, backup, { alive: (pid) => pid === 4242 })).toThrow(
      /running .*pid 4242.*Stop it/s,
    );
    expect(listBackups(join(dir, BACKUPS_DIR))).toHaveLength(1);
  });

  it("treats a pid file whose process is gone as stale", () => {
    const dir = dataFolder();
    writeFileSync(join(dir, PID_FILE), "4242\n");
    expect(runningStackPid(dir, () => false)).toBeNull();
    expect(runningStackPid(dir, () => true)).toBe(4242);
    writeFileSync(join(dir, PID_FILE), "garbage\n");
    expect(runningStackPid(dir, () => true)).toBeNull();
  });

  it("puts back the database, keys and engine, and keeps what it replaced", () => {
    const dir = dataFolder(["before"]);
    const backup = backupDataDir(dir, { now: at("2026-10-01T00:00:00Z") });

    // Everything moves on after the backup, including a WAL that must not survive the restore.
    const live = new Database(join(dir, "solow.db"));
    live.exec("PRAGMA wal_autocheckpoint = 0;");
    live.query("INSERT INTO note (body) VALUES ('after')").run();
    writeFileSync(join(dir, "secret.key"), "key-b\n");
    rmSync(join(dir, "inngest"), { recursive: true });
    mkdirSync(join(dir, "inngest"));
    writeFileSync(join(dir, "inngest", "later.txt"), "x");

    const result = restoreDataDir(dir, backup, { now: at("2026-10-02T00:00:00Z") });
    live.close();

    expect(notes(join(dir, "solow.db"))).toEqual(["before"]);
    expect(readFileSync(join(dir, "secret.key"), "utf8")).toBe("key-a\n");
    expect(existsSync(join(dir, "inngest", "main.db"))).toBe(true);
    expect(existsSync(join(dir, "inngest", "later.txt"))).toBe(false);

    expect(result.previous).toBe(join(dir, BACKUPS_DIR, "20261002T000000Z-pre-restore"));
    const previous = result.previous as string;
    expect(notes(join(previous, "solow.db"))).toEqual(["before", "after"]);
    expect(readFileSync(join(previous, "secret.key"), "utf8")).toBe("key-b\n");
  });

  it("finds a backup by the name `list` prints", () => {
    const dir = dataFolder(["named"]);
    backupDataDir(dir, { now: at("2026-10-01T00:00:00Z") });
    const result = restoreDataDir(dir, "20261001T000000Z-manual");
    expect(result.manifest.kind).toBe("manual");
  });

  it("restores into an empty folder, as on a new machine", () => {
    const backup = backupDataDir(dataFolder(["moved"]));
    const fresh = join(scratch(), "data");
    const result = restoreDataDir(fresh, backup);
    expect(result.previous).toBeNull();
    expect(notes(join(fresh, "solow.db"))).toEqual(["moved"]);
    expect(readFileSync(join(fresh, "secret.key"), "utf8")).toBe("key-a\n");
  });

  it("refuses a directory that is not a finished backup", () => {
    const dir = dataFolder();
    const backup = backupDataDir(dir);
    rmSync(join(backup, MANIFEST_FILE));
    expect(() => restoreDataDir(dir, backup)).toThrow(/not a complete backup/);
    expect(() => restoreDataDir(dir, "no-such-backup")).toThrow(/no backup at/);
  });

  it("leaves the engine alone when the backup has none, and undoes itself", () => {
    const dir = dataFolder(["first"]);
    const backup = backupDataDir(dir, { engine: false, now: at("2026-10-01T00:00:00Z") });
    writeFileSync(join(dir, "inngest", "kept.txt"), "x");

    const result = restoreDataDir(dir, backup, { now: at("2026-10-02T00:00:00Z") });
    expect(existsSync(join(dir, "inngest", "kept.txt"))).toBe(true);

    // Restoring the copy the restore made is how it is undone.
    restoreDataDir(dir, result.previous as string, { now: at("2026-10-03T00:00:00Z") });
    expect(notes(join(dir, "solow.db"))).toEqual(["first"]);
  });
});

describe("backupBeforeMigrate", () => {
  function migrated(): string {
    const dir = scratch();
    const sqlite = new Database(join(dir, "solow.db"), { create: true });
    sqlite.exec("PRAGMA foreign_keys = OFF;");
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
    sqlite.close();
    writeFileSync(join(dir, "dev-secret.key"), "dev-key\n");
    return dir;
  }

  /** As the database was before the newest migration shipped. */
  function forgetNewestMigration(path: string): void {
    const db = new Database(path);
    db.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations);",
    );
    db.close();
  }

  it("counts what drizzle would apply", () => {
    const dir = migrated();
    const path = join(dir, "solow.db");
    expect(pendingMigrations(path, MIGRATIONS)).toBe(0);
    forgetNewestMigration(path);
    expect(pendingMigrations(path, MIGRATIONS)).toBe(1);

    const empty = join(scratch(), "empty.db");
    new Database(empty, { create: true }).close();
    const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
    expect(pendingMigrations(empty, MIGRATIONS)).toBe(journal.entries.length);
  });

  it("copies the database and its key before a pending migration, and only then", () => {
    const dir = migrated();
    const path = join(dir, "solow.db");
    expect(backupBeforeMigrate(path, MIGRATIONS)).toBeNull();

    forgetNewestMigration(path);
    const copy = backupBeforeMigrate(path, MIGRATIONS, { now: at("2026-10-08T00:00:00Z") });
    expect(copy).toBe(join(dir, BACKUPS_DIR, "20261008T000000Z-pre-migrate"));
    const manifest = readManifest(copy as string);
    expect(manifest.kind).toBe("pre-migrate");
    expect(manifest.keys).toEqual(["dev-secret.key"]);
    expect(manifest.engine).toBe(false);
    expect(pendingMigrations(join(copy as string, "solow.db"), MIGRATIONS)).toBe(1);
  });

  it("does nothing for a database that does not exist yet", () => {
    expect(backupBeforeMigrate(join(scratch(), "solow.db"), MIGRATIONS)).toBeNull();
  });

  it("keeps only the newest pre-migrate copies", () => {
    const dir = migrated();
    const path = join(dir, "solow.db");
    forgetNewestMigration(path);
    for (const day of ["01", "02", "03"]) {
      backupBeforeMigrate(path, MIGRATIONS, { keep: 2, now: at(`2026-10-${day}T00:00:00Z`) });
    }
    expect(listBackups(join(dir, BACKUPS_DIR)).map((entry) => entry.name)).toEqual([
      "20261003T000000Z-pre-migrate",
      "20261002T000000Z-pre-migrate",
    ]);
  });
});
