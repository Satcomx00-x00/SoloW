/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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
