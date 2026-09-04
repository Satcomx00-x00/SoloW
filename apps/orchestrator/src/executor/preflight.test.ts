import { describe, expect, it } from "bun:test";
import {
  containerName,
  type DockerExecutorConfig,
  type DockerIds,
  deploymentId,
} from "./docker.js";
import { type PreflightOpts, type PreflightResult, probeExecutor } from "./preflight.js";
import type { ExecResult, Executor, ProcessHandle } from "./types.js";

/**
 * The Docker preflight against a fake host `Executor` (issue #96, spec F07 AC-6).
 *
 * Every `ok: false` here is a `failureReason` an operator reads on a failed card and acts on, so
 * what this file pins is not that the preflight refuses — it is *which* refusal it prints. Round
 * two of review found the three ways it named the wrong thing, each caught only by a live daemon:
 * a broken image reported as an uninstalled Docker, an unreadable `docker info` reported as an
 * unfit kernel, and a verdict handed back with the container that produced it still running.
 *
 * A fake host rather than a daemon, and it is enough for exactly these: the preflight reaches
 * Docker by composing argv for a host `Executor`, so what it concluded and what it did about it
 * are both readable as strings. The live half — that the daemon and the images really behave this
 * way — is `scripts/smoke-docker-executor.sh` and the round-two reproduction it was fixed against.
 */

const IDS: DockerIds = { workspaceId: "ws-1", taskId: "task-1", sessionId: "sess-1" };
const WORKTREE_ROOT = "/srv/solow/worktrees";
const JAIL_ROOT = "/srv/solow/worktrees/ws-1/task-1";
const NAME = containerName(IDS, deploymentId(WORKTREE_ROOT));

const CONFIG: DockerExecutorConfig = {
  kind: "docker",
  image: "solow/agent:1",
  mounts: [],
  env: {},
};

function opts(overrides: Partial<PreflightOpts> = {}): PreflightOpts {
  return {
    jailRoot: JAIL_ROOT,
    worktreeRoot: WORKTREE_ROOT,
    repoCacheRoot: "/srv/solow/repos",
    dockerBin: "docker",
    user: "1000:1000",
    ...overrides,
  };
}

type Answer = Partial<ExecResult> | Error;

/**
 * A daemon that says yes to every rung, with the answers the preflight actually reads.
 *
 * `overrides` match the joined argv and are consulted first, so a case states only the one answer
 * it is about; an `Error` in that position is *thrown* rather than returned, which is how a host
 * executor reports a binary that is not there (`Bun.spawn` raises ENOENT synchronously).
 */
function daemon(overrides: Array<[RegExp, Answer]> = []) {
  return (cmd: string[]): Answer => {
    const line = cmd.join(" ");
    for (const [pattern, answer] of overrides) if (pattern.test(line)) return answer;
    // `realpath -m -- <path>`: the mount guard asks the host where a bind source really points,
    // and fails closed on an empty answer, so a fake that ignored it would refuse every mount
    // before the preflight reached its first rung. Identity — no path here is a symlink, and what
    // the guard does with a differing answer is pinned in `docker.test.ts`.
    if (cmd[0] === "realpath") return { stdout: `${cmd[3]}\n` };
    if (cmd[0] !== "docker") return {}; // the `mkdir -p` that pre-creates the bind sources
    if (cmd[1] === "version") return { stdout: "29.7.2\n" };
    if (cmd[1] === "info") return { stdout: "true true true\n" };
    if (cmd[1] === "image") return { stdout: "sha256:d15c0ffee\n" };
    if (cmd[1] === "ps") return { stdout: "" }; // nothing to adopt: the creation path
    if (cmd[1] === "run") return { stdout: "d15c0ffee\n" };
    if (cmd[1] === "inspect") return { stdout: "true 0\n" };
    return {}; // `docker exec` — the owner claim and the utility probe, which reports none missing
  };
}

interface FakeHost {
  executor: Executor;
  /** Every argv the preflight handed the host, in order. */
  calls: string[][];
}

function fakeHost(respond = daemon()): FakeHost {
  const calls: string[][] = [];
  const settle = (cmd: string[]): ExecResult => {
    const answer = respond(cmd);
    if (answer instanceof Error) throw answer;
    return { stdout: "", stderr: "", exitCode: 0, ...answer };
  };
  const unused = () => {
    throw new Error("the preflight must not use the host executor's fs, forward or metrics");
  };

  const executor: Executor = {
    async exec(cmd) {
      calls.push(cmd);
      return settle(cmd);
    },
    spawn(cmd): ProcessHandle {
      // Only the prepare script, which travels on stdin and so cannot go through `exec`.
      calls.push(cmd);
      const result = settle(cmd);
      return {
        stdin: { write: (data: string) => data.length, flush: async () => 0, end: async () => {} },
        stdout: once(result.stdout),
        stderr: once(result.stderr),
        exited: Promise.resolve(result.exitCode),
        kill: () => {},
      };
    },
    async baseEnv() {
      return {};
    },
    fs: { exists: unused, readFile: unused, writeFile: unused, list: unused, copy: unused },
    forward: unused,
    metrics: unused,
    async dispose() {},
  };
  return { executor, calls };
}

async function* once(text: string): AsyncGenerator<Uint8Array> {
  if (text) yield new TextEncoder().encode(text);
}

/** ENOENT as a host executor raises it: a `code` and the argv[0] it failed on, not a message. */
function enoent(path: string): Error {
  return Object.assign(new Error(`Executable not found in $PATH: "${path}"`), {
    code: "ENOENT",
    path,
    errno: -2,
  });
}

function reasonOf(result: PreflightResult): string {
  if (result.ok) throw new Error("expected a refusal, got ok: true");
  return result.reason;
}

describe("the missing-Docker diagnosis is not the container's to make", () => {
  it("reports a broken image in the image's own words, not as an absent Docker", async () => {
    /*
     * The regression, live and verbatim: `hashicorp/terraform-mcp-server:0.2.3` has no `/bin/sh`,
     * so its entrypoint dies with `exec /bin/sh failed: No such file or directory`, which
     * `ensureContainer` quotes into its `ExecutorUnavailableError`. The old catch matched that
     * text and answered that the "docker" command was not found — on a host answering `Docker
     * version 29.7.2` — sending an operator to reinstall Docker on a machine whose Docker is fine.
     */
    const host = fakeHost(
      daemon([
        [/inspect -f \{\{\.State\.Running/, { stdout: "false 127\n" }],
        [
          /^docker logs/,
          { stderr: "[FATAL tini (7)] exec /bin/sh failed: No such file or directory\n" },
        ],
      ]),
    );

    const reason = reasonOf(await probeExecutor(host.executor, CONFIG, IDS, opts()));

    expect(reason).toContain('container for image "solow/agent:1" exited immediately (code 127)');
    expect(reason).toContain("exec /bin/sh failed: No such file or directory");
    expect(reason).not.toContain("Docker is not available on this host");
  });

  it("still names an absent docker binary when the host executor raises ENOENT for it", async () => {
    const host = fakeHost(daemon([[/^docker version/, enoent("docker")]]));

    expect(reasonOf(await probeExecutor(host.executor, CONFIG, IDS, opts()))).toBe(
      'Docker is not available on this host: the "docker" command was not found',
    );
  });

  it("rethrows an ENOENT for some other binary, so a flake is retried rather than misdiagnosed", async () => {
    // `ensureContainer` pre-creates the bind sources with `mkdir`. A host missing *that* says
    // nothing about Docker, and the verdict would be unactionable as well as untrue.
    const host = fakeHost(daemon([[/^mkdir/, enoent("mkdir")]]));

    await expect(probeExecutor(host.executor, CONFIG, IDS, opts())).rejects.toThrow(
      'Executable not found in $PATH: "mkdir"',
    );
  });
});

describe("a verdict takes its container with it", () => {
  it("removes the container when the image is missing the utilities the shims need", async () => {
    const host = fakeHost(daemon([[/for c in/, { stdout: "git\n" }]]));

    const reason = reasonOf(await probeExecutor(host.executor, CONFIG, IDS, opts()));

    expect(reason).toBe('image "solow/agent:1" is missing utilities the executor needs: git');
    // The invariant `ensureContainer` states for itself, which these rungs run after: a failed
    // preflight must leave nothing behind for the reaper to explain later.
    expect(host.calls).toContainEqual(["docker", "rm", "-f", NAME]);
  });

  it("removes the container when the profile's prepare script fails", async () => {
    const host = fakeHost(
      daemon([[/exec -i --user 0:0/, { stderr: "apk: could not resolve\n", exitCode: 100 }]]),
    );

    const reason = reasonOf(
      await probeExecutor(
        host.executor,
        { ...CONFIG, prepareScript: "apk add --no-cache curl" },
        IDS,
        opts(),
      ),
    );

    expect(reason).toBe("the profile's prepare script failed (exit 100): apk: could not resolve");
    // Removal is what makes the next pass rebuild: adopting a half-prepared container skips the
    // script entirely, since it runs only on the pass that created one.
    expect(host.calls).toContainEqual(["docker", "rm", "-f", NAME]);
  });

  it("leaves the container running when the preflight passes, for the driver to adopt", async () => {
    const host = fakeHost();

    expect(await probeExecutor(host.executor, CONFIG, IDS, opts())).toEqual({
      ok: true,
      agentCommands: [],
    });
    expect(host.calls).not.toContainEqual(["docker", "rm", "-f", NAME]);
  });
});

describe("the mount guard's host utility is asked about the host, not about a path", () => {
  /**
   * busybox `realpath` has no `-m`; whether the BSD one macOS ships does was not established.
   *
   * The mount guard sends every bind source *and* every allow-list rule through `realpath -m`
   * and fails closed, so on such a host nothing mounts at all. Verified on 29.7.2 that
   * `docker run --rm alpine:latest realpath -m -- /a/b/c` answers exactly the stderr below and
   * exits 1 (it has no `--` either). Without this rung the Task dies naming one bind source, and
   * an operator goes looking at that path instead of at their userland.
   */
  it("names the host's realpath rather than failing one bind source at a time", async () => {
    const host = fakeHost(
      daemon([[/^realpath/, { exitCode: 1, stderr: "realpath: -m: No such file or directory\n" }]]),
    );

    const reason = reasonOf(await probeExecutor(host.executor, CONFIG, IDS, opts()));

    expect(reason).toContain("the mount guard cannot run on this host");
    expect(reason).toContain("which busybox's does not and a non-GNU one may not");
    expect(reason).toContain("realpath: -m: No such file or directory");
    // Not a sentence about one of the paths the deployment happens to be configured with.
    expect(reason).not.toContain(JAIL_ROOT);

    // Asked once about the host, and before anything expensive: a userland that cannot answer
    // must not first spend minutes pulling an image it will never run.
    const asked = host.calls.filter((cmd) => cmd[0] === "realpath");
    expect(asked).toHaveLength(1);
    expect(host.calls.some((cmd) => cmd[1] === "image" || cmd[1] === "pull")).toBe(false);
    expect(host.calls.some((cmd) => cmd[1] === "run")).toBe(false);
  });

  it("asks about a path that cannot exist, because that is the property `-m` has", async () => {
    // A `realpath` without `-m` cannot answer about a path that is not there, and the guard's
    // sources mostly are not there yet — `ensureContainer` creates them afterwards. So the probe
    // has to be a missing path; one that resolved would prove nothing about the flag.
    const host = fakeHost();
    expect(await probeExecutor(host.executor, CONFIG, IDS, opts())).toEqual({
      ok: true,
      agentCommands: [],
    });

    const probe = host.calls.find((cmd) => cmd[0] === "realpath");
    expect(probe?.slice(0, 3)).toEqual(["realpath", "-m", "--"]);
    expect(probe?.[3]).toMatch(/^\/[^/]+\//);
    expect(host.calls.some((cmd) => cmd[0] === "mkdir" && cmd.includes(probe?.[3] ?? ""))).toBe(
      false,
    );
  });
});

describe("limit support is read, not assumed", () => {
  it("reports that it could not read the host's limit support when docker info fails", async () => {
    // Unread, the exit code turned "I could not find out" into three confident kernel diagnoses:
    // an empty stdout splits into empty fields and every limit asked for reads as unsupported.
    const host = fakeHost(daemon([[/^docker info/, { stderr: "boom\n", exitCode: 1 }]]));

    const reason = reasonOf(
      await probeExecutor(host.executor, { ...CONFIG, cpus: 0.5, memoryMb: 256 }, IDS, opts()),
    );

    expect(reason).toBe("could not read this Docker host's limit support — boom");
    expect(reason).not.toContain("kernel");
  });

  it("still fails a profile whose limits this kernel cannot enforce", async () => {
    const host = fakeHost(daemon([[/^docker info/, { stdout: "false false false\n" }]]));

    expect(
      reasonOf(
        await probeExecutor(host.executor, { ...CONFIG, cpus: 0.5, memoryMb: 256 }, IDS, opts()),
      ),
    ).toBe(
      "this Docker host cannot enforce the limits this profile asks for (memory limit unsupported by the kernel, swap limit unsupported by the kernel, CPU quota unsupported by the kernel)",
    );
  });
});
