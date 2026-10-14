/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `scripts/lib/data-dir.sh`, sourced by real `sh` the way the launchers source it. The folder holds
 * the master key and a database with session tokens in it, so what is asserted here is who else
 * on the machine can read them: nobody.
 */

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "solow-data-dir-"));
  dirs.push(dir);
  return dir;
}

/** Source the library with `$SOLOW_HOME` at `home`, then run `after` in the same shell. */
function source(home: string, after = ":") {
  // A permissive umask first, as a login shell on a shared box has: the library must not rely on
  // whatever the caller happened to inherit.
  const script = `set -eu\numask 002\nLOG_TAG=test\n. "$ROOT/scripts/lib/data-dir.sh"\n${after}\n`;
  const result = Bun.spawnSync(["sh", "-c", script], {
    env: { ...process.env, ROOT, SOLOW_HOME: home },
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
}

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

test("creates a missing folder private, and everything made after it too", () => {
  const home = join(scratch(), "nested", ".solow");
  source(
    home,
    `: > "$GC_DIR/written-by-launcher"
sh -c ': > "$SOLOW_HOME/written-by-child"; mkdir "$SOLOW_HOME/made-by-child"'`,
  );
  expect(mode(home)).toBe("700");
  expect(mode(join(home, "written-by-launcher"))).toBe("600");
  // The services are children of the launcher: a database's -wal and -shm, a backup and an engine
  // file are created by them, not by the script.
  expect(mode(join(home, "written-by-child"))).toBe("600");
  expect(mode(join(home, "made-by-child"))).toBe("700");
});

test("tightens a folder an earlier version left readable, and only SoloW's files in it", () => {
  const home = scratch();
  chmodSync(home, 0o775);
  const files = [
    "dev-secret.key",
    "secret.key",
    "auth.secret",
    "orchestrator.secret",
    "inngest-signing.key",
    "solow.db",
    "solow.db-wal",
    "solow.db-shm",
  ];
  for (const name of files) writeFileSync(join(home, name), "x", { mode: 0o664 });
  mkdirSync(join(home, "inngest", "nested"), { recursive: true, mode: 0o775 });
  chmodSync(join(home, "inngest"), 0o775);
  writeFileSync(join(home, "inngest", "main.db"), "x", { mode: 0o664 });
  writeFileSync(join(home, "inngest", "nested", "state"), "x", { mode: 0o664 });
  mkdirSync(join(home, "backups", "20261008T000000Z-manual"), { recursive: true, mode: 0o775 });
  chmodSync(join(home, "backups"), 0o775);
  writeFileSync(join(home, "backups", "20261008T000000Z-manual", "secret.key"), "x", {
    mode: 0o664,
  });
  // Not SoloW's: a debugging aid someone parked in the folder keeps the mode they gave it.
  writeFileSync(join(home, "chrome-debug.log"), "x");
  // Set after the fact: `writeFileSync`'s mode is filtered through this runner's own umask.
  for (const name of [...files, "chrome-debug.log"]) chmodSync(join(home, name), 0o664);
  chmodSync(join(home, "inngest", "main.db"), 0o664);
  chmodSync(join(home, "inngest", "nested"), 0o775);
  chmodSync(join(home, "inngest", "nested", "state"), 0o664);
  chmodSync(join(home, "backups", "20261008T000000Z-manual"), 0o775);
  chmodSync(join(home, "backups", "20261008T000000Z-manual", "secret.key"), 0o664);

  source(home);
  // Run twice: a second start on an already-private folder changes nothing and fails nothing.
  source(home);

  expect(mode(home)).toBe("700");
  for (const name of files) expect([name, mode(join(home, name))]).toEqual([name, "600"]);
  expect(mode(join(home, "inngest"))).toBe("700");
  expect(mode(join(home, "inngest", "nested"))).toBe("700");
  expect(mode(join(home, "inngest", "main.db"))).toBe("600");
  expect(mode(join(home, "inngest", "nested", "state"))).toBe("600");
  expect(mode(join(home, "backups"))).toBe("700");
  expect(mode(join(home, "backups", "20261008T000000Z-manual"))).toBe("700");
  expect(mode(join(home, "backups", "20261008T000000Z-manual", "secret.key"))).toBe("600");
  expect(mode(join(home, "chrome-debug.log"))).toBe("664");
});

/** Run the library's claim in `sh`, as a launcher does right before it starts anything. */
function claim(home: string, after = ":") {
  const script = `set -eu\nLOG_TAG=test\n. "$ROOT/scripts/lib/data-dir.sh"\nclaim_data_dir\n${after}\n`;
  return Bun.spawn(["sh", "-c", script], {
    env: { ...process.env, ROOT, SOLOW_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a second launcher refuses while anything the first one started is still running", async () => {
  const home = scratch();
  // A launcher that starts a service and is then killed outright: the service is reparented and
  // keeps running on the folder, which a pid file naming the launcher could not say.
  const first = claim(home, "sleep 60 &\necho $!\nwait");
  const reader = first.stdout.getReader();
  const { value } = await reader.read();
  const service = Number(new TextDecoder().decode(value).trim());
  expect(alive(service)).toBe(true);
  first.kill("SIGKILL");
  await first.exited;

  try {
    const second = claim(home);
    expect(await second.exited).toBe(1);
    const stderr = await new Response(second.stderr).text();
    expect(stderr).toContain(`SoloW is already running on ${home}`);
  } finally {
    process.kill(service, "SIGKILL");
  }

  // Once the last of it is gone, so is the lock.
  const deadline = Date.now() + 5_000;
  while (alive(service) && Date.now() < deadline) await Bun.sleep(50);
  const third = claim(home);
  expect(await third.exited).toBe(0);
}, 15_000);

test("the launchers replace an empty master key, as they do every other key", () => {
  // Stopped at their first `bun`, which a stand-in on PATH fails: by then every key is made.
  const shims = scratch();
  writeFileSync(join(shims, "bun"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  chmodSync(join(shims, "bun"), 0o755);
  for (const launcher of ["dev.sh", "start.sh"]) {
    const home = scratch();
    writeFileSync(join(home, "dev-secret.key"), "");
    writeFileSync(join(home, "auth.secret"), "");
    const result = Bun.spawnSync(["sh", join(ROOT, "scripts", launcher)], {
      // SOLOW_AUTH_SECRET blank: the root test preload exports one, and an exported key wins.
      env: {
        ...process.env,
        PATH: `${shims}:${process.env.PATH}`,
        SOLOW_HOME: home,
        SOLOW_AUTH_SECRET: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect([launcher, result.exitCode]).toEqual([launcher, 3]);
    for (const name of ["dev-secret.key", "auth.secret"]) {
      const key = readFileSync(join(home, name), "utf8").trim();
      expect([launcher, name, key.length]).toEqual([launcher, name, 44]);
    }
  }
});

test("a restore refuses while anything the stack started still holds the folder", async () => {
  const home = scratch();
  const db = new Database(join(home, "solow.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE note (body TEXT);");
  db.close();
  const backupSh = (...args: string[]) =>
    Bun.spawnSync(["sh", join(ROOT, "scripts", "backup.sh"), ...args], {
      env: { ...process.env, SOLOW_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
  expect(backupSh("backup").exitCode).toBe(0);
  const [name] = readdirSync(join(home, "backups"));

  // As in the case above: a launcher killed outright, one of its services still running.
  const launcher = claim(home, "sleep 60 &\necho $!\nwait");
  const reader = launcher.stdout.getReader();
  const service = Number(new TextDecoder().decode((await reader.read()).value).trim());
  launcher.kill("SIGKILL");
  await launcher.exited;

  try {
    const refused = backupSh("restore", name as string);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.toString()).toContain(`SoloW is already running on ${home}`);
    // Listing what there is to restore needs no lock, and is no reason to stop anything.
    expect(backupSh("restore").stdout.toString()).toContain(name as string);
  } finally {
    process.kill(service, "SIGKILL");
  }

  const deadline = Date.now() + 5_000;
  while (alive(service) && Date.now() < deadline) await Bun.sleep(50);
  const restored = backupSh("restore", name as string);
  expect(restored.stderr.toString()).toBe("");
  expect(restored.exitCode).toBe(0);
}, 30_000);
