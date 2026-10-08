/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `scripts/lib/supervise.sh`, driven the way the launchers drive it: real `sh`, real processes,
 * fake services. Timing-based by nature — the backoff is in whole seconds — so each case waits
 * for an observable effect with a deadline rather than sleeping a fixed amount.
 */

const LIB = join(import.meta.dir, "lib", "supervise.sh");
const dirs: string[] = [];
const launchers: Bun.Subprocess[] = [];

afterEach(() => {
  for (const proc of launchers.splice(0)) proc.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A launcher in miniature: a flaky service, a steady one, and the same wait/stop as start.sh. */
function launch(flaky: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "solow-supervise-"));
  dirs.push(dir);
  const script = `
set -eu
. "$LIB"
trap 'supervise_stop; exit 0' TERM
supervise flaky sh -c '${flaky}'
supervise steady sh -c 'echo $$ > "$DIR/steady.pid"; exec sleep 600'
supervise_wait || { supervise_stop; exit 1; }
`;
  const proc = Bun.spawn(["sh", "-c", script], {
    env: { ...process.env, LIB, DIR: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  launchers.push(proc);
  return { proc, dir };
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(100);
  }
  return check();
}

const lines = (file: string) =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length : 0;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("restarts a service that exits, and leaves the others running", async () => {
  const { proc, dir } = launch('echo up >> "$DIR/flaky.log"; sleep 0.2; exit 3', {
    SOLOW_RESTART_LIMIT: "10",
  });
  const steadyPidFile = join(dir, "steady.pid");
  expect(await until(() => lines(steadyPidFile) === 1, 5_000)).toBe(true);
  const steady = Number(readFileSync(steadyPidFile, "utf8"));

  expect(await until(() => lines(join(dir, "flaky.log")) >= 3, 10_000)).toBe(true);
  expect(alive(steady)).toBe(true);
  expect(readFileSync(steadyPidFile, "utf8").trim()).toBe(String(steady));

  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
  expect(await until(() => !alive(steady), 5_000)).toBe(true);
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).toContain("flaky exited (status 3) — restarting in 1s (attempt 1 of 10)");
  expect(stderr).toContain("restarting in 2s (attempt 2 of 10)");
}, 20_000);

test("gives up on a crash loop and takes the stack down with a failure", async () => {
  const { proc, dir } = launch('echo up >> "$DIR/flaky.log"; exit 7', {
    SOLOW_RESTART_LIMIT: "2",
  });
  const steadyPidFile = join(dir, "steady.pid");
  expect(await until(() => lines(steadyPidFile) === 1, 5_000)).toBe(true);
  const steady = Number(readFileSync(steadyPidFile, "utf8"));

  expect(await proc.exited).toBe(1);
  // The first run and two restarts, then nothing more.
  expect(lines(join(dir, "flaky.log"))).toBe(3);
  expect(await until(() => !alive(steady), 5_000)).toBe(true);
  const stderr = await new Response(proc.stderr).text();
  expect(stderr).toContain("flaky exited (status 7) 2 times in a row — giving up");
}, 20_000);

test("a stop during the backoff stops at once and starts nothing new", async () => {
  const { proc, dir } = launch('echo up >> "$DIR/flaky.log"; exit 1', {
    SOLOW_RESTART_LIMIT: "10",
  });
  // Two runs means the second backoff (2s) has begun.
  expect(await until(() => lines(join(dir, "flaky.log")) === 2, 10_000)).toBe(true);
  const stoppedAt = Date.now();
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
  expect(Date.now() - stoppedAt).toBeLessThan(1_500);
  await Bun.sleep(2_500);
  expect(lines(join(dir, "flaky.log"))).toBe(2);
}, 20_000);
