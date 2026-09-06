import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The launcher's precondition failures, asserted on the message a person actually reads
 * (issue #17 AC-4, and its Definition of Done: "each precondition failure covered by a test
 * asserting the message").
 *
 * These spawn `bin/solow.mjs` for real rather than importing it. That is not a shortcut — it is
 * the only honest shape available. The file is a script with no exports: it parses `process.argv`
 * and calls `process.exit` on every path below, so there is nothing to import and call, and a
 * refactor to make it importable would be a change to production code made solely to suit a test.
 * Spawning also covers the thing a unit test would quietly skip: that the message reaches
 * `stderr` and the exit status is non-zero, which is what a shell, a CI step and a person all
 * read.
 *
 * Every case stops before any service starts, so nothing binds a port or leaves a child process
 * behind. It does **not** follow that nothing is written: `buildEnv` creates the data directory
 * and generates three keys into it, and only the `git` check now runs ahead of that — the port
 * check does not, so the busy-port case really does leave a directory. Writing this test is what
 * surfaced that ordering, since the first version pointed `SOLOW_HOME` at a path named for never
 * being created and then created it. Hence a real temp directory, removed afterwards.
 */

const LAUNCHER = join(import.meta.dir, "..", "bin", "solow.mjs");
const HOMES: string[] = [];

afterAll(() => {
  for (const home of HOMES) rmSync(home, { recursive: true, force: true });
});

function runLauncher(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "solow-launcher-home-"));
  HOMES.push(home);
  const result = spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, SOLOW_HOME: home, ...env },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
    home,
  };
}

test("names `git` and gives the remedy when it cannot be run", () => {
  /*
   * A `git` that is present and broken, rather than an empty PATH.
   *
   * `PATH=""` does not simulate an absent binary: `execvp` falls back to a default search path
   * when the variable is empty, so the real `git` is still found and the launcher runs straight
   * past this check — verified, it reached the bootstrap step. Pointing PATH at a directory
   * holding a `git` that exits non-zero is both reliable and the harder case: it is the shim, the
   * unsatisfied dynamic link and the Windows Store stub, all of which pass a `command -v` lookup
   * and fail the first clone. That is why the check runs `--version` instead of looking it up.
   */
  const shimDir = mkdtempSync(join(tmpdir(), "solow-launcher-test-"));
  try {
    const shim = join(shimDir, "git");
    writeFileSync(shim, '#!/bin/sh\necho "git: broken" >&2\nexit 1\n');
    chmodSync(shim, 0o755);

    const { status, stderr, home } = runLauncher([], { PATH: shimDir });

    expect(status).not.toBe(0);
    expect(stderr).toContain("could not run `git`");
    // The remedy is the half that makes it actionable, and the half a reworded message would drop.
    expect(stderr).toMatch(/apt install git|xcode-select|winget install Git/);

    // And it refused before creating anything. `buildEnv` makes the data directory and generates
    // three keys into it, so a check that ran afterwards would leave that on the disk of a machine
    // it has just declared unusable — and the next run would find keys it never chose to make.
    // `mkdtempSync` created `home`, so the directory exists; what must not be there is its contents.
    expect(existsSync(join(home, "secret.key"))).toBe(false);
    expect(existsSync(join(home, "solow.db"))).toBe(false);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test("names the port, the service holding it, and what to do about it", () => {
  // A real listener rather than a stubbed check: the launcher asks the operating system whether
  // the port is free, so this test has to answer that question truthfully. Port 0 lets the kernel
  // pick one, so it cannot flake on a machine that happens to be using the number we guessed.
  const server = Bun.serve({ port: 0, fetch: () => new Response("holding this port") });

  try {
    const { status, stderr } = runLauncher(["--port", String(server.port)]);
    expect(status).not.toBe(0);
    expect(stderr).toContain(`port ${server.port}`);
    expect(stderr).toContain("already in use");
    expect(stderr).toContain("pass a different port");
  } finally {
    server.stop(true);
  }
});

test("refuses a port outside the range instead of handing it to the kernel", () => {
  const { status, stderr } = runLauncher(["--port", "70000"]);

  expect(status).not.toBe(0);
  expect(stderr).toContain("--port");
  // The value is echoed back, because "expects a port 1-65535" alone leaves the reader checking
  // their own command line for which of the three ports they got wrong.
  expect(stderr).toContain("70000");
});

test("refuses an unknown option and says where the list is", () => {
  const { status, stderr } = runLauncher(["--no-such-flag"]);

  expect(status).not.toBe(0);
  expect(stderr).toContain("unknown option: --no-such-flag");
  expect(stderr).toContain("--help");
});

test("`--help` is not a failure, and says what the first run will do", () => {
  const { status, stdout } = runLauncher(["--help"]);

  // The inverse of every case above: the same argument parser must exit 0 here, or a person
  // asking for help gets a shell error for their trouble.
  expect(status).toBe(0);
  expect(stdout).toContain("--port");
  expect(stdout).toContain("--data-dir");
  // First-run behaviour is the thing someone runs `--help` to find out before committing to it.
  expect(stdout).toMatch(/data directory|~\/\.solow|SOLOW_HOME/);
});
