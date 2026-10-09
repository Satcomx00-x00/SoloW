import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EXECUTOR_IMAGE } from "../../contracts/src/executor-isolation.js";

/**
 * `solow executor-image` (roadmap B4), against a stand-in `docker` that records what it was asked.
 *
 * Spawned for real, as `launcher-preconditions.test.ts` explains. What is pinned is what the
 * guided setup depends on: the tag is the one the orchestrator looks for, the Dockerfile goes in
 * on stdin with no build context, and the image is only called ready after its harnesses ran as
 * this user with a tmpfs `HOME` — the way a Task runs them. Building a real image takes a daemon
 * and minutes; `make executor-image` is where that is done.
 */

const LAUNCHER = join(import.meta.dir, "..", "bin", "solow.mjs");
const DOCKERFILE = join(import.meta.dir, "..", "..", "..", "docker", "executor", "Dockerfile");
const DIRS: string[] = [];

afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true });
});

/** A `docker` that logs each argv and stdin, and fails `run` when told to. */
function fakeDocker(failRun = false) {
  const dir = mkdtempSync(join(tmpdir(), "solow-executor-image-"));
  DIRS.push(dir);
  const bin = join(dir, "docker");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "${dir}/argv"`,
      `if [ "$1" = build ]; then cat > "${dir}/stdin"; fi`,
      `if [ "$1" = run ] && [ "${failRun ? 1 : 0}" = 1 ]; then echo "claude: not found" >&2; exit 127; fi`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    argv: () => readFileSync(join(dir, "argv"), "utf8").trim().split("\n"),
    stdin: () => readFileSync(join(dir, "stdin"), "utf8"),
  };
}

function run(args: string[], env: Record<string, string>) {
  // The settings it reads, cleared so a developer's own environment cannot change the answer.
  const { SOLOW_EXECUTOR_IMAGE: _image, SOLOW_DOCKER_USER: _user, ...rest } = process.env;
  return spawnSync(process.execPath, [LAUNCHER, "executor-image", ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...rest, ...env },
  });
}

test("builds the tag the setup looks for, from the Dockerfile on stdin, then runs both harnesses", () => {
  const docker = fakeDocker();

  const result = run([], { SOLOW_DOCKER_BIN: docker.bin });

  expect(result.status).toBe(0);
  const [build, check] = docker.argv();
  // No context directory: `-` reads the Dockerfile itself, so nothing local is sent to the daemon.
  expect(build).toBe(`build --tag ${DEFAULT_EXECUTOR_IMAGE} -`);
  expect(docker.stdin()).toBe(readFileSync(DOCKERFILE, "utf8"));
  // As this uid, with HOME a tmpfs — what the driver imposes on every Task.
  const uid = process.getuid?.();
  expect(check).toContain(`--user ${uid}:${process.getgid?.()}`);
  expect(check).toContain("--tmpfs /home/solow:rw,exec");
  expect(check).toContain(`${DEFAULT_EXECUTOR_IMAGE} -c claude --version && opencode --version`);
  expect(result.stdout).toContain("is ready");
});

test("builds the image the orchestrator was told to look for instead, or the one named", () => {
  const fromEnv = fakeDocker();
  run([], { SOLOW_DOCKER_BIN: fromEnv.bin, SOLOW_EXECUTOR_IMAGE: "mine/harness:2" });
  expect(fromEnv.argv()[0]).toBe("build --tag mine/harness:2 -");

  const named = fakeDocker();
  run(["--tag", "other:1"], { SOLOW_DOCKER_BIN: named.bin });
  expect(named.argv()[0]).toBe("build --tag other:1 -");
});

test("checks as the uid the orchestrator was told to run containers as", () => {
  const docker = fakeDocker();
  run([], { SOLOW_DOCKER_BIN: docker.bin, SOLOW_DOCKER_USER: "1234:5678" });
  const check = docker.argv()[1];
  expect(check).toContain("--user 1234:5678");
  expect(check).toContain("uid=1234,gid=5678");
});

test("does not call an image ready when its harnesses do not run as this user", () => {
  const docker = fakeDocker(true);

  const result = run([], { SOLOW_DOCKER_BIN: docker.bin });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("did not run as this user");
  expect(result.stdout).not.toContain("is ready");
});

test("says Docker is what is missing when there is none", () => {
  const result = run([], { SOLOW_DOCKER_BIN: "/nonexistent/docker" });

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("needs Docker on this machine");
});
