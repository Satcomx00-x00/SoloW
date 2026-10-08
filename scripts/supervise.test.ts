/// <reference types="bun-types" />

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  // A failed case leaves supervisors and services behind once their launcher is killed.
  for (const dir of dirs.splice(0)) {
    for (const pid of tagged(dir)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
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

/**
 * A service that is more than one process, as each real one is: `bun run dev` starts `next dev`,
 * which starts the server that listens, and `bunx inngest-cli` starts the engine binary. The
 * wrapper writes its own pid and the listener's, then waits on it.
 */
const WRAPPED = 'sleep 600 & echo "$$ $!" >> "$DIR/flaky.pids"; trap "" TERM; wait; wait; exit 9';

/**
 * Every process still running that this test's launcher started, found by the `DIR` each one
 * inherited. Linux only (`/proc`); elsewhere nothing is found and the check proves nothing.
 */
function tagged(dir: string): number[] {
  if (!existsSync("/proc/self/environ")) return [];
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/environ`, "latin1").includes(`DIR=${dir}\0`)) {
        found.push(Number(entry));
      }
    } catch {
      // gone already, or not ours to read
    }
  }
  return found;
}

function pids(dir: string): [number, number][] {
  const file = join(dir, "flaky.pids");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ").map(Number) as [number, number]);
}

test("a restart takes the rest of the service down with its top process", async () => {
  const { proc, dir } = launch(WRAPPED, { SOLOW_RESTART_LIMIT: "10" });
  expect(await until(() => pids(dir).length === 1, 5_000)).toBe(true);
  const [[wrapper, listener]] = pids(dir) as [[number, number]];

  // The wrapper dies and the listener it started does not: the orphan that held the port and
  // made every restart fail on EADDRINUSE.
  process.kill(wrapper, "SIGKILL");
  expect(await until(() => !alive(listener), 5_000)).toBe(true);
  expect(await until(() => pids(dir).length === 2, 5_000)).toBe(true);

  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
}, 20_000);

test("a stop leaves no process of any service behind", async () => {
  const { proc, dir } = launch(WRAPPED, { SOLOW_RESTART_LIMIT: "10", SOLOW_STOP_GRACE: "2" });
  expect(await until(() => pids(dir).length === 1, 5_000)).toBe(true);
  const [[wrapper, listener]] = pids(dir) as [[number, number]];

  const stoppedAt = Date.now();
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
  // The wrapper ignores TERM, so it took the KILL after the grace period, and nothing else.
  expect(Date.now() - stoppedAt).toBeLessThan(4_500);
  expect(alive(wrapper)).toBe(false);
  expect(alive(listener)).toBe(false);
  // Nor the grace timer: one left running would fire at a pid that may by then be someone else's.
  expect(await until(() => tagged(dir).length === 0, 1_000)).toBe(true);
}, 20_000);
