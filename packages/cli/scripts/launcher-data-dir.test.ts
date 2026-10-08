import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What `bin/solow.mjs` leaves in the data folder, spawned for real like
 * `launcher-preconditions.test.ts` and for the same reason: the file is a script with no exports.
 *
 * Every case is stopped by a busy port, which the launcher checks after it has prepared the data
 * folder and before it starts anything, so the folder is in exactly the state a real start would
 * leave it in and no service is ever spawned.
 */

const LAUNCHER = join(import.meta.dir, "..", "bin", "solow.mjs");
const HOMES: string[] = [];

afterAll(() => {
  for (const home of HOMES) rmSync(home, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "solow-launcher-data-"));
  HOMES.push(dir);
  return dir;
}

/** Run the launcher against `home` until it refuses the busy port. */
function startUntilPortCheck(home: string, env: Record<string, string> = {}) {
  const server = Bun.serve({ port: 0, fetch: () => new Response("busy") });
  try {
    const result = spawnSync(process.execPath, [LAUNCHER, "--port", String(server.port)], {
      encoding: "utf8",
      timeout: 30_000,
      // Blank, not inherited: the root test preload exports test keys, and an exported key wins
      // over the file, so nothing would be written for these tests to look at.
      env: {
        ...process.env,
        SOLOW_SECRET_KEY: "",
        SOLOW_AUTH_SECRET: "",
        SOLOW_STREAM_SECRET: "",
        SOLOW_HOME: home,
        ...env,
      },
    });
    expect(result.stderr).toContain("already in use");
    return result;
  } finally {
    server.stop(true);
  }
}

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

test("creates the data folder and every key in it readable by its owner only", () => {
  const home = join(scratch(), "nested", "solow");
  startUntilPortCheck(home);

  expect(mode(home)).toBe("700");
  const keys = readdirSync(home);
  expect(keys).toContain("secret.key");
  for (const name of keys) expect([name, mode(join(home, name))]).toEqual([name, "600"]);
});

test("tightens a folder an earlier version left readable, and only SoloW's files in it", () => {
  const home = scratch();
  const owned = ["secret.key", "auth.secret", "solow.db", "solow.db-wal", "solow.db-shm"];
  for (const name of [...owned, "notes.txt"]) writeFileSync(join(home, name), "x");
  mkdirSync(join(home, "inngest"));
  writeFileSync(join(home, "inngest", "main.db"), "x");
  mkdirSync(join(home, "backups"));
  // After the fact: a mode passed when creating is filtered through this runner's umask.
  chmodSync(home, 0o775);
  for (const name of [...owned, "notes.txt"]) chmodSync(join(home, name), 0o664);
  chmodSync(join(home, "inngest"), 0o775);
  chmodSync(join(home, "inngest", "main.db"), 0o664);
  chmodSync(join(home, "backups"), 0o775);

  startUntilPortCheck(home);

  expect(mode(home)).toBe("700");
  for (const name of owned) expect([name, mode(join(home, name))]).toEqual([name, "600"]);
  expect(mode(join(home, "inngest"))).toBe("700");
  expect(mode(join(home, "inngest", "main.db"))).toBe("600");
  expect(mode(join(home, "backups"))).toBe("700");
  expect(mode(join(home, "notes.txt"))).toBe("664");
});

/** A port nothing listens on: the kernel picks one and it is released straight away. */
function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = server;
  server.stop(true);
  return port as number;
}

test("refuses to start while anything of another stack holds the data folder's lock", async () => {
  const home = scratch();
  // What `scripts/dev.sh` leaves behind when it is killed outright: a service still holding the
  // descriptor the lock is on.
  const holder = Bun.spawn(
    ["sh", "-c", 'exec 9>>"$0/solow.lock" && flock -n 9 && echo ready && exec sleep 60', home],
    { stdout: "pipe" },
  );
  try {
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");

    const ports = ["--port", "--ws-port", "--inngest-port"].flatMap((flag) => [
      flag,
      String(freePort()),
    ]);
    const result = spawnSync(process.execPath, [LAUNCHER, ...ports, "--no-open"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, SOLOW_HOME: home },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`SoloW is already running on ${home}`);
    expect(result.stderr).toContain("solow.lock");

    // `solow restore` refuses on the same lock, before it touches anything.
    const restore = spawnSync(process.execPath, [LAUNCHER, "restore", "some-backup"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, SOLOW_HOME: home },
    });
    expect(restore.status).not.toBe(0);
    expect(restore.stderr).toContain(`SoloW is already running on ${home}`);
  } finally {
    holder.kill("SIGKILL");
  }
});
