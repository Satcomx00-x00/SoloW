/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Backups of the data folder (FINDINGS F1): a consistent copy of the database, the keys that make
 * it readable, and the engine's own state, taken without stopping anything.
 *
 * Why not copy the folder: the database runs in WAL mode and the stack writes to it all the time,
 * so a file copy can catch `solow.db` and `solow.db-wal` at two different moments, and the result
 * is a database that opens but holds half a transaction. `VACUUM INTO` reads one snapshot inside
 * a read transaction and writes a self-contained file, so the copy is consistent even while the
 * web app and the orchestrator keep writing — and it is plain SQL, which `bun:sqlite` has where it
 * has no binding for the C backup API.
 *
 * A backup is a directory, not an archive: nothing to install on any platform, and every file in
 * it is the file it will be restored as. The manifest is written last, so a directory without one
 * is a backup that did not finish and is never offered for restore.
 */

export const DATABASE_FILE = "solow.db";
/** `inngest start --sqlite-dir`: queued events and in-flight runs (Decision 0004). */
export const ENGINE_DIR = "inngest";
export const BACKUPS_DIR = "backups";
/** Written by the launchers while the stack is up; what `restore` refuses on. */
export const PID_FILE = "solow.pid";
export const MANIFEST_FILE = "manifest.json";
/** Automatic copies kept per kind. Manual backups are never pruned: the person made them. */
export const DEFAULT_KEEP = 5;

/**
 * Every key a launcher generates into the data folder. Without `secret.key` (npx) or
 * `dev-secret.key` (repo) the stored provider tokens in a restored database cannot be decrypted,
 * so a backup without its keys is not a backup. Listed rather than globbed so a stray log or a
 * hand-made copy beside them never ends up inside one.
 */
export const KEY_FILES = [
  "secret.key",
  "dev-secret.key",
  "auth.secret",
  "stream.secret",
  "orchestrator.secret",
  "inngest-signing.key",
  "inngest-event.key",
] as const;

export type BackupKind = "manual" | "pre-migrate" | "pre-restore";
const KINDS: readonly BackupKind[] = ["manual", "pre-migrate", "pre-restore"];

export interface BackupManifest {
  format: 1;
  kind: BackupKind;
  createdAt: string;
  /** The key files copied alongside the database. */
  keys: string[];
  /** Whether the engine's state is in the backup. A pre-migrate copy leaves it out. */
  engine: boolean;
}

export interface BackupEntry {
  name: string;
  path: string;
  manifest: BackupManifest;
}

/** A refusal or failure meant for the person running the command, not a stack trace. */
export class BackupError extends Error {
  override name = "BackupError";
}

const SQLITE_HEADER = "SQLite format 3\0";
/** Files SQLite keeps beside a database; never copied on their own. */
const SIDECARS = ["-wal", "-shm", "-journal"];

// ---------------------------------------------------------------------------- snapshots

/**
 * A consistent copy of one SQLite database, verified before it is trusted.
 *
 * Opened read-write (never created): a read-only connection cannot open a WAL database whose
 * `-shm` is missing, and `VACUUM INTO` changes nothing in the source either way. The busy timeout
 * covers the moment a writer holds the lock a read transaction has to wait behind.
 */
export function snapshotSqlite(source: string, target: string): void {
  if (existsSync(target)) throw new BackupError(`${target} already exists`);
  mkdirSync(dirname(target), { recursive: true });
  const db = new Database(source, { readwrite: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout = 10000;");
    db.query("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  chmodSync(target, 0o600);
  verifySqlite(target);
}

/** `quick_check` on a copy: a backup that cannot be read is worse than none, because it is trusted. */
export function verifySqlite(path: string): void {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query("PRAGMA quick_check;").all() as Record<string, string>[];
    const verdict = rows.map((row) => Object.values(row)[0]).join("; ");
    if (verdict !== "ok") throw new BackupError(`${path} failed its integrity check: ${verdict}`);
  } finally {
    db.close();
  }
}

function isSqlite(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(16);
    return readSync(fd, head, 0, 16, 0) === 16 && head.toString("latin1") === SQLITE_HEADER;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The engine's directory, file by file: SQLite files by snapshot (the engine is writing them if
 * the stack is up), anything else as it is. Its WAL and shared-memory files are skipped — the
 * snapshot already holds what they hold.
 */
function copyEngineState(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyEngineState(from, to);
    } else if (entry.isFile()) {
      if (SIDECARS.some((suffix) => entry.name.endsWith(suffix))) continue;
      if (isSqlite(from)) snapshotSqlite(from, to);
      else copyFileSync(from, to);
    }
  }
}

// ---------------------------------------------------------------------------- backup

export interface BackupOptions {
  kind?: BackupKind | undefined;
  /** The directory the backup is created in. Defaults to `<dataDir>/backups`. */
  into?: string | undefined;
  /** The database to copy. Defaults to `<dataDir>/solow.db`. */
  database?: string | undefined;
  /** Include the engine's state (default true). */
  engine?: boolean | undefined;
  now?: Date | undefined;
}

/** `20261008T140402Z`: sorts as it reads, and is safe in a file name on every platform. */
export function backupStamp(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

function freshDirectory(parent: string, base: string): string {
  let candidate = join(parent, base);
  for (let n = 2; existsSync(candidate); n++) candidate = join(parent, `${base}-${n}`);
  return candidate;
}

/** Take a backup of a data folder. Returns the backup's directory. */
export function backupDataDir(dataDir: string, options: BackupOptions = {}): string {
  const kind = options.kind ?? "manual";
  const database = options.database ?? join(dataDir, DATABASE_FILE);
  if (!existsSync(database)) {
    throw new BackupError(`there is no database at ${database}, so there is nothing to back up`);
  }
  const now = options.now ?? new Date();
  const parent = resolve(options.into ?? join(dataDir, BACKUPS_DIR));
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = freshDirectory(parent, `${backupStamp(now)}-${kind}`);
  mkdirSync(target, { mode: 0o700 });

  try {
    snapshotSqlite(database, join(target, DATABASE_FILE));

    const keys = KEY_FILES.filter((name) => existsSync(join(dataDir, name)));
    for (const name of keys) {
      copyFileSync(join(dataDir, name), join(target, name));
      chmodSync(join(target, name), 0o600);
    }

    const engineDir = join(dataDir, ENGINE_DIR);
    const engine = options.engine !== false && existsSync(engineDir);
    if (engine) copyEngineState(engineDir, join(target, ENGINE_DIR));

    const manifest: BackupManifest = {
      format: 1,
      kind,
      createdAt: now.toISOString(),
      keys: [...keys],
      engine,
    };
    writeFileSync(join(target, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    // Half a backup must not look like one.
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
  return target;
}

// ---------------------------------------------------------------------------- listing

export function readManifest(path: string): BackupManifest {
  const file = join(path, MANIFEST_FILE);
  if (!existsSync(file)) {
    throw new BackupError(`${path} is not a complete backup (no ${MANIFEST_FILE})`);
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new BackupError(`${file} is not valid JSON`);
  }
  if (manifest.format !== 1 || !KINDS.includes(manifest.kind) || !Array.isArray(manifest.keys)) {
    throw new BackupError(`${file} is not a backup manifest this version can read`);
  }
  if (!existsSync(join(path, DATABASE_FILE))) {
    throw new BackupError(`${path} has a manifest but no ${DATABASE_FILE}`);
  }
  return manifest;
}

/** Complete backups in a directory, newest first. */
export function listBackups(dir: string): BackupEntry[] {
  if (!existsSync(dir)) return [];
  const entries: BackupEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    try {
      entries.push({ name: entry.name, path, manifest: readManifest(path) });
    } catch {
      // Not a backup, or one that did not finish: neither is offered.
    }
  }
  return entries.sort(
    (a, b) =>
      b.manifest.createdAt.localeCompare(a.manifest.createdAt) || b.name.localeCompare(a.name),
  );
}

/**
 * Keep the `keep` newest automatic backups of one kind and remove the rest. `except` is never
 * removed — the backup a restore is reading from, when that restore just made a newer one.
 */
export function pruneBackups(
  dir: string,
  kind: BackupKind,
  keep: number,
  except?: string,
): string[] {
  if (kind === "manual") return [];
  const removed: string[] = [];
  const ofKind = listBackups(dir).filter((entry) => entry.manifest.kind === kind);
  for (const entry of ofKind.slice(Math.max(keep, 0))) {
    if (except !== undefined && resolve(entry.path) === resolve(except)) continue;
    rmSync(entry.path, { recursive: true, force: true });
    removed.push(entry.path);
  }
  return removed;
}

/** `SOLOW_BACKUP_KEEP`, or the default when it is unset or not a whole number. */
export function keepFromEnv(value: string | undefined = process.env.SOLOW_BACKUP_KEEP): number {
  const n = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(n) && n >= 1 ? n : DEFAULT_KEEP;
}

// ---------------------------------------------------------------------------- running stack

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just is not ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The pid of the stack running on this data folder, or null when none is. */
export function runningStackPid(
  dataDir: string,
  alive: (pid: number) => boolean = processAlive,
): number | null {
  let text: string;
  try {
    text = readFileSync(join(dataDir, PID_FILE), "utf8");
  } catch {
    return null;
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return alive(pid) ? pid : null;
}

// ---------------------------------------------------------------------------- restore

/** A path to a backup, or the name of one in `<dataDir>/backups`. */
export function resolveBackup(dataDir: string, ref: string): string {
  const direct = resolve(ref);
  if (existsSync(direct) && statSync(direct).isDirectory()) return direct;
  const named = join(dataDir, BACKUPS_DIR, ref);
  if (existsSync(named) && statSync(named).isDirectory()) return named;
  throw new BackupError(`no backup at ${direct} or ${named}`);
}

export interface RestoreOptions {
  now?: Date | undefined;
  keep?: number | undefined;
  alive?: ((pid: number) => boolean) | undefined;
}

export interface RestoreResult {
  source: string;
  manifest: BackupManifest;
  /** A backup of what was there before, or null when the data folder had no database. */
  previous: string | null;
}

/**
 * Put a backup back into a data folder. Refused while the stack runs on that folder: the services
 * hold the database open and would keep writing into the file being replaced, and the engine
 * would carry on with runs the restored database knows nothing about.
 *
 * What was there before is backed up first (`pre-restore`), so a restore can itself be undone.
 * Worktrees, the repository cache and imported Skills are left where they are; they are not in a
 * backup (see `docs/operations/backup-and-restore.md`).
 */
export function restoreDataDir(
  dataDir: string,
  ref: string,
  options: RestoreOptions = {},
): RestoreResult {
  const pid = runningStackPid(dataDir, options.alive);
  if (pid !== null) {
    throw new BackupError(
      `SoloW is running on ${dataDir} (pid ${pid}). Stop it before restoring.\n` +
        `If nothing is running, the pid file is stale: remove ${join(dataDir, PID_FILE)}.`,
    );
  }

  const source = resolveBackup(dataDir, ref);
  const manifest = readManifest(source);
  verifySqlite(join(source, DATABASE_FILE));

  mkdirSync(dataDir, { recursive: true });
  const database = join(dataDir, DATABASE_FILE);
  const previous = existsSync(database)
    ? backupDataDir(dataDir, { kind: "pre-restore", now: options.now })
    : null;

  // Staged beside the target and renamed over it, so the database is either the old file or the
  // new one. Its WAL and shared memory go first: a WAL left beside a replaced database would be
  // replayed into it on the next open.
  const staged = `${database}.restoring`;
  rmSync(staged, { force: true });
  copyFileSync(join(source, DATABASE_FILE), staged);
  chmodSync(staged, 0o600);
  for (const suffix of SIDECARS) rmSync(`${database}${suffix}`, { force: true });
  renameSync(staged, database);

  for (const name of manifest.keys) {
    if (!(KEY_FILES as readonly string[]).includes(name)) continue;
    const target = join(dataDir, name);
    copyFileSync(join(source, name), target);
    chmodSync(target, 0o600);
  }

  if (manifest.engine) {
    const engineDir = join(dataDir, ENGINE_DIR);
    rmSync(engineDir, { recursive: true, force: true });
    copyTree(join(source, ENGINE_DIR), engineDir);
  }

  pruneBackups(join(dataDir, BACKUPS_DIR), "pre-restore", options.keep ?? keepFromEnv(), source);
  return { source, manifest, previous };
}

function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (lstatSync(from).isFile()) copyFileSync(from, to);
  }
}

// ---------------------------------------------------------------------------- migrations

/**
 * How many generated migrations this database has not had yet — the same rule drizzle's SQLite
 * migrator applies: every journal entry newer than the newest `created_at` it recorded.
 */
export function pendingMigrations(sqlitePath: string, migrationsFolder: string): number {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  const entries: { when: number }[] = journal.entries ?? [];
  const db = new Database(sqlitePath, { readwrite: true, create: false });
  try {
    const table = db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
      .get();
    if (!table) return entries.length;
    const row = db
      .query("SELECT created_at AS last FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1")
      .get() as { last: number | string | null } | null;
    if (row === null || row.last === null) return entries.length;
    const last = Number(row.last);
    return entries.filter((entry) => last < entry.when).length;
  } finally {
    db.close();
  }
}

/**
 * The copy taken before an upgrade changes the database. Only when there is something to change:
 * migrations run on every start, and a copy on every start would rotate the one that matters —
 * the last one before a schema change — out of the kept set within a day.
 *
 * Returns the backup's directory, or null when no copy was needed (no database yet, or nothing
 * pending). Throws when a copy was needed and could not be taken, and the caller must not migrate.
 */
export function backupBeforeMigrate(
  sqlitePath: string,
  migrationsFolder: string,
  options: { keep?: number | undefined; now?: Date | undefined } = {},
): string | null {
  if (!existsSync(sqlitePath) || statSync(sqlitePath).size === 0) return null;
  if (pendingMigrations(sqlitePath, migrationsFolder) === 0) return null;
  const dataDir = dirname(resolve(sqlitePath));
  const copy = backupDataDir(dataDir, {
    kind: "pre-migrate",
    database: sqlitePath,
    engine: false,
    now: options.now,
  });
  pruneBackups(join(dataDir, BACKUPS_DIR), "pre-migrate", options.keep ?? keepFromEnv());
  return copy;
}
