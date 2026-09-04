import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  CONTAINER_HOME,
  containerName,
  createDockerExecutor,
  type DockerExecutorConfig,
  type DockerExecutorOpts,
  type DockerIds,
  deploymentId,
  diagnosisLine,
  ExecutorUnavailableError,
  ensureContainer,
  failureText,
  guardMountSource,
  lastLine,
  type MountRoots,
  type ResolveLinks,
  runPrepareScript,
} from "./docker.js";
import type { ExecResult, Executor, ProcessHandle } from "./types.js";

/**
 * The Docker driver against a fake host `Executor` that only records argv (issue #96, F07).
 *
 * No daemon, and that is the point of the driver's shape rather than a compromise this file
 * makes: because `docker.ts` reaches the daemon by composing argv for a host `Executor` instead
 * of calling one itself, everything it decides — the run line, where the environment travels,
 * when a non-zero exit is the container's death rather than the command's answer — is decided
 * in argv this file can read back. A driver that spoke to the socket directly would leave all of
 * that testable only on a machine with Docker on it, which CI is not.
 *
 * The behaviour every driver shares is *not* here: it is in `contract.ts`, run against a real
 * daemon by `docker.live.test.ts`. What this file pins is what only the Docker driver does.
 */

const IDS: DockerIds = { workspaceId: "ws-1", taskId: "task-1", sessionId: "sess-1" };
const WORKTREE_ROOT = "/srv/solow/worktrees";
const JAIL_ROOT = "/srv/solow/worktrees/ws-1/task-1";
const DEPLOYMENT = deploymentId(WORKTREE_ROOT);
const NAME = containerName(IDS, DEPLOYMENT);

/** A uid stated rather than taken from `process.getuid()`, so the run line is machine-independent. */
const USER = "1000:1000";

const CONFIG: DockerExecutorConfig = {
  kind: "docker",
  image: "solow/agent:1",
  mounts: [{ source: "/srv/data", target: "/data", readOnly: true }],
  network: "solow-net",
  cpus: 2,
  memoryMb: 512,
  // The value below must not reach argv on the host, where `ps` shows it — see the test.
  env: { SOLOW_TEST_TOKEN: "sk-must-not-be-in-argv" },
};

function opts(overrides: Partial<DockerExecutorOpts> = {}): DockerExecutorOpts {
  return {
    jailRoot: JAIL_ROOT,
    worktreeRoot: WORKTREE_ROOT,
    bindPaths: ["/srv/repos/app"],
    dockerBin: "docker",
    user: USER,
    ...overrides,
  };
}

type Responder = (cmd: string[]) => Partial<ExecResult>;

/**
 * A daemon that says yes to everything, with the answers `ensureContainer` actually reads.
 *
 * `overrides` are matched against the joined argv first, so a test states only the one answer it
 * is about — a test that had to spell out the whole conversation would break every time an
 * unrelated rung was added to creation.
 */
function daemon(overrides: Array<[RegExp, Partial<ExecResult>]> = []): Responder {
  return (cmd) => {
    const line = cmd.join(" ");
    for (const [pattern, result] of overrides) if (pattern.test(line)) return result;
    /*
     * `realpath -m -- <path>` is the mount guard's one host call, and it has to be answered
     * before the daemon conversation starts: the guard fails closed on an empty answer, so a
     * fake that ignored it would refuse every bind source in this file. Identity, because none
     * of these paths exists on the machine running the test — the guard's *use* of a differing
     * answer is pinned by the symlink test below, against a real one.
     */
    if (cmd[0] === "realpath") return { stdout: `${cmd[3]}\n` };
    // Nothing already labelled for this Task: the creation path, not the adoption one.
    if (cmd[1] === "ps") return { stdout: "" };
    if (cmd[1] === "run") return { stdout: "d15c0ffee\n" };
    if (cmd[1] === "inspect") return { stdout: "true 0\n" };
    return {};
  };
}

interface FakeHost {
  executor: Executor;
  /** Every argv the driver handed the host, `exec` and `spawn` alike, in order. */
  calls: string[][];
  /** Everything written to a spawned process's stdin — where the environment travels. */
  stdin: string[];
}

function fakeHost(respond: Responder = daemon()): FakeHost {
  const calls: string[][] = [];
  const stdin: string[] = [];
  const settle = (cmd: string[]): ExecResult => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    ...respond(cmd),
  });

  const unused = () => {
    // Asserted by construction rather than by a test: the driver reaches the host only through
    // `exec` and `spawn`. If it ever read the host's own `fs` or `metrics` it would be answering
    // about the orchestrator's machine while claiming to describe the container.
    throw new Error("the Docker driver must not use the host executor's fs, forward or metrics");
  };

  const executor: Executor = {
    async exec(cmd) {
      calls.push(cmd);
      return settle(cmd);
    },
    spawn(cmd): ProcessHandle {
      calls.push(cmd);
      const result = settle(cmd);
      return {
        stdin: {
          write: (data: string) => {
            stdin.push(data);
            return data.length;
          },
          flush: async () => 0,
          end: async () => {},
        },
        stdout: once(result.stdout),
        stderr: once(result.stderr),
        exited: Promise.resolve(result.exitCode),
        kill: () => {},
      };
    },
    async baseEnv() {
      return {};
    },
    fs: {
      exists: unused,
      readFile: unused,
      writeFile: unused,
      list: unused,
      copy: unused,
    },
    forward: unused,
    metrics: unused,
    async dispose() {},
  };
  return { executor, calls, stdin };
}

async function* once(text: string): AsyncGenerator<Uint8Array> {
  if (text) yield new TextEncoder().encode(text);
}

/** `kill` is fire-and-forget by the interface, so its argv arrives a tick or two later. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("creation — the docker run line", () => {
  it("composes the exact argv, in the order the daemon reads it", async () => {
    const host = fakeHost();
    await ensureContainer(host.executor, CONFIG, IDS, opts());

    const run = host.calls.find((cmd) => cmd[1] === "run");
    // The fingerprint is derived from the whole immutable configuration, so it is read out of
    // the line rather than restated here — a second copy of that hash in a test would be a
    // second definition of what "the same container" means.
    const cfg = run?.find((arg) => arg.startsWith("solow.cfg="))?.slice("solow.cfg=".length);
    expect(cfg).toMatch(/^[0-9a-f]{16}$/);

    expect(run).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      NAME,
      "--label",
      "solow.managed=true",
      "--label",
      "solow.role=session",
      "--label",
      "solow.schema=1",
      "--label",
      `solow.deployment=${DEPLOYMENT}`,
      "--label",
      "solow.workspace=ws-1",
      "--label",
      "solow.task=task-1",
      "--label",
      "solow.run=sess-1",
      "--label",
      `solow.cfg=${cfg}`,
      "--init",
      "--user",
      USER,
      "--tmpfs",
      "/run/solow:rw,mode=0700,uid=1000,gid=1000,size=1m",
      // The agent's `HOME`, so a credential a tool caches there dies with the container instead
      // of being written into the bind-mounted worktree on the host — see `CONTAINER_HOME`.
      // `exec` is named because Docker mounts a tmpfs `noexec` by default, which would break
      // every agent CLI that installs a helper under `~/.local/bin`.
      "--tmpfs",
      "/home/solow:rw,exec,mode=0700,uid=1000,gid=1000,size=64m",
      "--mount",
      "type=bind,source=/srv/data,target=/data,readonly",
      "--mount",
      "type=bind,source=/srv/repos/app,target=/srv/repos/app",
      "--mount",
      `type=bind,source=${JAIL_ROOT},target=${JAIL_ROOT}`,
      "--network",
      "solow-net",
      "--cpus",
      "2",
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
      "--pids-limit",
      "512",
      "--security-opt",
      "no-new-privileges:true",
      "--entrypoint",
      "/bin/sh",
      "solow/agent:1",
      "-c",
      "while :; do sleep 3600; done",
    ]);
  });

  it("creates every bind source on the host before the run that would refuse it", async () => {
    const host = fakeHost();
    await ensureContainer(host.executor, CONFIG, IDS, opts());

    const run = host.calls.findIndex((cmd) => cmd[1] === "run");
    const mkdirs = host.calls.filter((cmd) => cmd[0] === "mkdir");

    expect(mkdirs.map((cmd) => cmd[2])).toEqual(["/srv/data", "/srv/repos/app", JAIL_ROOT]);
    // Every one of them *before* the run: `--mount type=bind` refuses a source that does not
    // exist, which is the loud failure we want for a path nobody knew about — where `-v` would
    // silently create a root-owned directory and hand the agent an empty worktree instead. It is
    // not the failure we want for the directories the driver could have made itself.
    for (const mkdir of mkdirs) expect(host.calls.indexOf(mkdir)).toBeLessThan(run);
  });

  it("puts no profile environment value anywhere in the run argv", async () => {
    const host = fakeHost();
    await ensureContainer(host.executor, CONFIG, IDS, opts());

    // `-e KEY=VALUE` would have been the obvious way to deliver the profile's environment, and
    // it puts the value in the docker CLI's argv on the *host*, where `ps` shows it to every
    // user on the machine. The environment travels on stdin instead — see the spawn test below.
    for (const cmd of host.calls) {
      expect(cmd.some((arg) => arg.includes("sk-must-not-be-in-argv"))).toBe(false);
      expect(cmd).not.toContain("-e");
    }
  });

  /*
   * The mount guard, as a table, because the two defects it had were both *arithmetic* rather
   * than a missing name — and a case-by-case test is exactly what let them through.
   *
   * The predecessor of this block asserted refusal for two hard-coded worktree roots, and
   * neither of them triggered either cause: the guard shipped admitting `~/.ssh`, `~/.aws`,
   * `~/.docker` and `/var/run/docker.sock`, reproduced by calling `guardMountSource` directly.
   * So every row states the layout it is about, and the two layouts a deployment actually has —
   * worktrees under `/srv`, and worktrees under a dot-directory in someone's home — are both
   * carried through the whole table.
   */
  /**
   * A deployment's two roots, both set — which is what production has: `factory.ts` builds one
   * options object from `env.ts` for the driver and its preflight, and `PreflightOpts` requires
   * the cache root. `MountRoots` leaves it optional only so a driver can be built without one in
   * a test, and the row for that case is in `REFUSED` below.
   */
  type Deployment = Required<MountRoots>;

  const SRV: Deployment = {
    worktreeRoot: "/srv/solow/worktrees",
    repoCacheRoot: "/srv/solow/repos",
  };
  const HOME: Deployment = {
    worktreeRoot: "/home/dev/.solow/worktrees",
    repoCacheRoot: "/home/dev/.solow/repos",
  };
  /** A deployment rooted one level under `/var` — the layout the `dirname` rule gave away. */
  const VAR: Deployment = {
    worktreeRoot: "/var/solow/worktrees",
    repoCacheRoot: "/var/solow/repos",
  };

  const MOUNTABLE: Array<[string, MountRoots, string]> = [
    // What production actually mounts: the worktree root and a Task's worktree under it.
    [SRV.worktreeRoot, SRV, "the worktree root itself, which task-run.ts passes as a bind path"],
    [JAIL_ROOT, SRV, "a Task's own worktree"],
    [HOME.worktreeRoot, HOME, "the worktree root when it is a dot-directory in a home"],
    ["/home/dev/.solow/worktrees/ws-1/task-1", HOME, "a Task's worktree in that layout"],
    [VAR.worktreeRoot, VAR, "the worktree root of a /var deployment"],
    // The cache root, recognised because it is passed, not because of where it sits.
    [SRV.repoCacheRoot, SRV, "SOLOW_REPO_CACHE_ROOT"],
    [HOME.repoCacheRoot, HOME, "SOLOW_REPO_CACHE_ROOT inside a dot-directory"],
    [VAR.repoCacheRoot, VAR, "SOLOW_REPO_CACHE_ROOT under /var"],
    ["/home/dev/.solow/repos/task-1", HOME, "one clone inside it"],
    // A `local_path` Repository where an Owner actually keeps one.
    ["/home/dev/code/app", HOME, "a Repository in a home directory"],
    ["/home/dev/code/app", SRV, "the same Repository from a deployment rooted elsewhere"],
    ["/home/dev/code", SRV, "the directory an Owner keeps repositories in"],
    ["/Users/dev/code/app", SRV, "the macOS spelling of the same thing"],
    ["/srv/repos/app", HOME, "a Repository inside a content area"],
    ["/srv/data", SRV, "a profile mount inside a content area"],
    ["/tmp/gc-docker-live-1/task-1", SRV, "the live suite's own worktree root, under /tmp"],
  ];

  const REFUSED: Array<[string, MountRoots, string]> = [
    ["/", SRV, "the whole disk"],
    ["/srv", SRV, "a content area itself, never merely inside it"],
    ["/home", SRV, "the parent of every account on the machine"],
    ["/home/dev", SRV, "a whole home directory"],
    ["/home/dev", HOME, "…including the one the deployment's own root is inside"],
    ["/home/dev/code/..", HOME, "the same hand-over spelled as a traversal"],
    ["/etc", SRV, "the host's own configuration"],
    ["/etc/shadow", SRV, "and a file in it"],
    ["/root", SRV, "root's home, which is not under a HOME_PARENT at all"],
    ["/root/.ssh", SRV, "and its keys"],
    /*
     * The escape, from every layout. `/var/run/docker.sock` is not a leak: an agent that reaches
     * the socket starts a privileged container and owns the machine. The `VAR` row is the one the
     * old `dirname(worktreeRoot)` rule admitted — a deployment rooted at `/var/solow` made every
     * path under `/var/` mountable, which is the whole of `/var/run` with it.
     */
    ["/var/run/docker.sock", SRV, "the daemon's socket"],
    ["/var/run/docker.sock", HOME, "…from a home-rooted deployment"],
    ["/var/run/docker.sock", { worktreeRoot: "/var/solow" }, "…from one rooted at /var/solow"],
    ["/var/run/docker.sock", VAR, "…and from one rooted a level deeper"],
    ["/var/run", { worktreeRoot: "/var/solow" }, "the directory holding it"],
    ["/var/lib", VAR, "any other sibling of the deployment's own directory"],
    /*
     * The dotfiles, from every layout. These were admitted by the rule that makes `~/code/app`
     * mountable, because that rule discriminated by *depth* — `.ssh` and `code` are both one
     * level below `$HOME`. Not one of them is named in `docker.ts`: they are refused for their
     * shape, so the next credential directory nobody has thought of is refused too.
     */
    ["/home/dev/.ssh", SRV, "private keys"],
    ["/home/dev/.ssh", HOME, "…from the layout whose own root is a dot-directory"],
    ["/home/dev/.aws", SRV, "cloud credentials"],
    ["/home/dev/.aws", HOME, "…likewise"],
    ["/home/dev/.docker", SRV, "registry credentials"],
    ["/home/dev/.docker", HOME, "…likewise"],
    ["/home/dev/.docker/config.json", HOME, "and the file inside it"],
    ["/home/dev/.config/gh", SRV, "a token store nothing in docker.ts names"],
    ["/home/dev/.gnupg", SRV, "nor this one"],
    ["/Users/dev/.ssh", SRV, "the macOS spelling"],
    ["/Users/dev/Library/Keychains", SRV, "and what macOS calls its hidden account state"],
    /*
     * All three spellings, because macOS is the one platform this rule is *for* and its volumes
     * are case-insensitive by default (APFS, HFS+). The guard shipped comparing `Library`
     * case-sensitively, so `~/library/Keychains` and `~/LIBRARY/Keychains` were mounted while
     * the row above was refused — three names for one directory, two of them a keychain handed
     * to the agent. Nothing equivalent is needed for the dot half: case cannot hide a leading `.`.
     */
    ["/Users/dev/library/Keychains", SRV, "…spelled lower-case, which opens the same directory"],
    ["/Users/dev/LIBRARY/Keychains", SRV, "…and upper-case, which opens it too"],
    /*
     * Not a path at all until `resolve()` has silently supplied the missing half from
     * `process.cwd()`. Both of these were *mounted*: the first as
     * `<the orchestrator's checkout>/relative/path`, the second as the checkout itself — so a
     * Repository whose `location` is `"."` handed the agent SoloW's own source, its
     * configuration and any `.env` beside it, read-write. The verdict must not depend on where
     * the test process was started either, which is the other half of why this is refused
     * outright rather than resolved.
     */
    ["relative/path", SRV, "a relative source, which resolve() would complete from the cwd"],
    ["", SRV, "an empty source, which resolve() would turn into the cwd itself"],
    [".", SRV, "the cwd spelled as a Repository location"],
    // The deployment's own dot-directory is only reachable through a root it was *told*.
    ["/home/dev/.solow/repos", { worktreeRoot: HOME.worktreeRoot }, "a cache root never passed in"],
    ["/home/dev/.solow", HOME, "the directory holding both roots, which is neither of them"],
    /*
     * The escape that went *around* every row above rather than through one: the daemon reads a
     * `--mount` value as CSV, so a comma in the path opens a new key and a later `src=` replaces
     * the source this guard just approved. Verified end to end on 29.7.2 — the first spelling
     * put the host root read-write at `/hostfs` (`/hostfs/etc/shadow` and `/hostfs/run/docker.sock`
     * both present), and the second, driven through `ensureContainer` itself, produced a
     * container whose `.Mounts` read `{"Source":"/var/run","RW":true}` with the host's Docker
     * socket in it. Every row here passed the whole table above: `/srv/…` and `/tmp/…` are
     * content areas, and the decoy source never has to exist, because the injected key replaces
     * it before the daemon looks.
     */
    ["/srv/repos/app,src=/,dst=/hostfs", SRV, "a source that reopens the --mount value it is in"],
    ["/tmp/x,src=/var/run", SRV, "…the two-field spelling, which needs no dst= at all"],
    ["/srv/repos/app,readonly", SRV, "…and the flag spelling, which rewrites nothing but lies"],
    ['/srv/repos/"app', SRV, "the quote, because the daemon parses this with a CSV reader"],
    ["/srv/repos/app\nfoo=bar", SRV, "a line break, which is that reader's record separator"],
  ];

  /**
   * A host on which nothing is a symlink, so each row above is about the arithmetic alone.
   *
   * None of those paths exists on the machine running this file, so a real `realpath` would be
   * answering about nothing. What the guard *does* with an answer that differs is the one thing
   * this cannot pin, and it is pinned against a real symlink two tests below.
   */
  const LEXICAL: ResolveLinks = async (path) => path;

  /**
   * The two sentences the guard refuses with, and nothing else counts as a refusal.
   *
   * Two, because the guard answers two different questions: whether the path is somewhere an
   * agent may be given, and whether the path can be handed to the daemon at all without
   * reopening the `--mount` value it is spliced into. An operator acts on those differently —
   * one is "register the Repository somewhere else", the other is "rename the directory" — so
   * they are separate sentences rather than one that covers both vaguely.
   */
  const REFUSAL = /would expose the host|reads a `--mount` value as CSV/;

  /**
   * One row's verdict as a string, so a failure names the row rather than a boolean.
   *
   * "refused" is only reported for the guard's own answer — `ExecutorUnavailableError` carrying
   * the sentence an operator reads — because the class is what tells the lifecycle this is the
   * execution host's answer and not the command's, and any other throw is a bug in the guard
   * rather than a refusal.
   */
  async function verdict(
    source: string,
    roots: MountRoots,
    resolveLinks: ResolveLinks = LEXICAL,
  ): Promise<string> {
    try {
      const mounted = await guardMountSource(source, roots, resolveLinks);
      return mounted === source ? "mounted" : "mounted, rewritten";
    } catch (cause) {
      const refused = cause instanceof ExecutorUnavailableError && REFUSAL.test(String(cause));
      return refused ? "refused" : `threw ${String(cause)}`;
    }
  }

  it("mounts every source the deployment actually uses", async () => {
    const verdicts = await Promise.all(
      MOUNTABLE.map(async ([source, roots, why]) => `${why} → ${await verdict(source, roots)}`),
    );
    expect(verdicts).toEqual(MOUNTABLE.map(([, , why]) => `${why} → mounted`));
  });

  it("refuses every source that would hand the agent the host", async () => {
    const verdicts = await Promise.all(
      REFUSED.map(async ([source, roots, why]) => `${why} → ${await verdict(source, roots)}`),
    );
    expect(verdicts).toEqual(REFUSED.map(([, , why]) => `${why} → refused`));
  });

  /**
   * The escape the table above cannot reach, against a symlink that really exists.
   *
   * `resolve()` is string arithmetic and the daemon is not: it follows the source's symlinks on
   * the host before it binds anything. Reproduced on Docker 29.7.2 — a link to `/` under `/tmp`,
   * which is a content area and world-writable, passed the lexical guard, and
   * `docker run --mount type=bind,source=<link>,target=/mnt/x` then showed
   * `/mnt/x/run/docker.sock` and `/mnt/x/etc/shadow` inside the container. So the guard is given
   * the host's own `realpath`, and both the lexical path and what it really points at have to
   * pass. `node:fs` here rather than the `Executor` seam only because a test *is* the host.
   */
  it("refuses a source whose symlink target escapes, and keeps one that lands inside", async () => {
    const dir = mkdtempSync(join(tmpdir(), "solow-guard-"));
    /*
     * `realpath -m` in `node:fs` terms — the longest prefix that exists, resolved, with the rest
     * normalised on the end. Plain `realpathSync` is not the seam's contract: the guard asks
     * about paths that do not exist yet (its sources, created afterwards) *and* about every rule
     * in the allow-list, and `/srv/solow/worktrees` is not on the machine running this file.
     */
    const real: ResolveLinks = async (path) => {
      const missing: string[] = [];
      for (let head = path; ; head = dirname(head)) {
        try {
          return join(realpathSync.native(head), ...missing);
        } catch {
          if (dirname(head) === head) return path;
          missing.unshift(basename(head));
        }
      }
    };
    try {
      symlinkSync("/", join(dir, "to-root"));
      symlinkSync("/etc", join(dir, "to-etc"));
      symlinkSync(dir, join(dir, "to-itself"));

      // Every one of these is inside `/tmp`, so the arithmetic alone says yes to all three.
      expect(await verdict(join(dir, "to-root"), SRV)).toBe("mounted");
      expect(await verdict(join(dir, "to-etc"), SRV)).toBe("mounted");

      expect(await verdict(join(dir, "to-root"), SRV, real)).toBe("refused");
      expect(await verdict(join(dir, "to-etc"), SRV, real)).toBe("refused");
      // And a link that stays inside a content area is still mountable — the deployment that
      // puts its repository cache on another volume by symlink is not collateral damage.
      expect(await verdict(join(dir, "to-itself"), SRV, real)).toBe("mounted");

      // The operator is told which path was the problem, not only the one they typed.
      await expect(guardMountSource(join(dir, "to-etc"), SRV, real)).rejects.toThrow(
        /a symlink to \/etc/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The layout that made the previous symlink fix refuse an entire OS family.
   *
   * Fedora Silverblue, CoreOS and the rest of the rpm-ostree family ship `/home` as a symlink to
   * `/var/home`; `/home -> /export/home` is the same shape on NFS layouts. The fix compared a
   * *resolved* source against *unresolved* rules, so `realpath /home/dev/code/app` came back as
   * `/var/home/dev/code/app`, which no rule reached — and on such a host no Task could start at
   * all, while the operator was told their own `$HOME` was "a symlink".
   */
  it("mounts on a host whose /home is a symlink, which is a whole OS family", async () => {
    const silverblue: ResolveLinks = async (path) =>
      path === "/home" || path.startsWith("/home/") ? `/var${path}` : path;

    const layout: Array<[string, string]> = [
      ["/home/dev/code/app", "an ordinary local_path Repository, the case the home rule is for"],
      [HOME.worktreeRoot, "the deployment's own worktree root"],
      ["/home/dev/.solow/worktrees/ws-1/task-1", "a Task's worktree under it"],
      [HOME.repoCacheRoot, "the repository cache root"],
      ["/home/dev/.solow/repos/task-1", "the cache clone inside it"],
    ];
    const verdicts = await Promise.all(
      layout.map(async ([source, why]) => `${why} → ${await verdict(source, HOME, silverblue)}`),
    );
    expect(verdicts).toEqual(layout.map(([, why]) => `${why} → mounted`));

    // And the rules still bite in the resolved spelling — this is not "resolve and allow".
    expect(await verdict("/home/dev/.ssh", HOME, silverblue)).toBe("refused");
    expect(await verdict("/home/dev", HOME, silverblue)).toBe("refused");
    expect(await verdict("/var/run/docker.sock", HOME, silverblue)).toBe("refused");
  });

  it("mounts on macOS, where /tmp is a symlink to /private/tmp", async () => {
    // The same defect on the other platform this allow-list has rules for: `/tmp` and `/var` are
    // symlinks into `/private` on every macOS volume, so a resolved source compared against an
    // unresolved `CONTENT_AREAS` refused `/tmp` — including the live suite's own worktree root.
    const macos: ResolveLinks = async (path) =>
      path === "/tmp" || path.startsWith("/tmp/") ? `/private${path}` : path;

    expect(await verdict("/tmp/gc-docker-live-1/task-1", SRV, macos)).toBe("mounted");
    // `/private` itself is not thereby an area: only what the rule resolved to is.
    expect(await verdict("/private/etc/master.passwd", SRV, macos)).toBe("refused");
  });

  /**
   * The escape that went around the allow-list instead of through it (reproduced on 29.7.2).
   *
   * `runArgs` joins the mount as `type=bind,source=…,target=…` and the daemon reads that with a
   * CSV reader, so an Owner-supplied path carrying a comma opens a new key: a later `src=`
   * replaces the approved source, and `dst=`/`target=` the approved target. The table above has
   * the sources; this is the same defect reached through the product's own entry point, and the
   * two surfaces the table cannot reach — the profile's `mounts[].target`, which nothing guarded
   * at all, and the shape of the value that finally reaches argv.
   */
  it("never lets a path add a key to the --mount value it is spliced into", async () => {
    const injected = fakeHost();
    await expect(
      ensureContainer(
        injected.executor,
        CONFIG,
        IDS,
        opts({ bindPaths: ["/tmp/solow-inj/x,src=/var/run"] }),
      ),
    ).rejects.toThrow(/may not contain a comma/);
    // Nothing was created: the refusal happens while the mounts are being decided.
    expect(injected.calls.some((cmd) => cmd[1] === "run")).toBe(false);

    // A profile's target is the other half, and it was unguarded: `bindsFor` checked
    // `mount.source` only, so this one overrode the source the guard had already approved.
    const target = fakeHost();
    await expect(
      ensureContainer(
        target.executor,
        { ...CONFIG, mounts: [{ source: "/srv/data", target: "/data,src=/", readOnly: false }] },
        IDS,
        opts(),
      ),
    ).rejects.toThrow(/a mount target may not contain a comma/);
    expect(target.calls.some((cmd) => cmd[1] === "run")).toBe(false);

    /*
     * And what does reach argv carries exactly the fields this file put there. The assertion is
     * on the *keys the daemon will parse out*, not on the string, because that is the thing the
     * escape changed: five keys came out of a value this file believed had three.
     */
    const ok = fakeHost();
    await ensureContainer(ok.executor, CONFIG, IDS, opts());
    const run = ok.calls.find((cmd) => cmd[1] === "run") ?? [];
    const mounts = run.filter((_arg, index) => run[index - 1] === "--mount");
    expect(mounts.length).toBe(3);
    for (const value of mounts) {
      const keys = value.split(",").map((field) => field.split("=")[0]);
      expect(keys.filter((key) => key !== "readonly")).toEqual(["type", "source", "target"]);
    }
  });

  it("asks the host about each path once, not once per source", async () => {
    // The allow-list is resolved through the same seam as the source (that is what fixes the
    // symlinked `/home`), which is a dozen fixed paths. Without memoising the resolver, every
    // one of them is re-forked for every bind source — three sources here, forty-odd forks.
    const host = fakeHost();
    await ensureContainer(host.executor, CONFIG, IDS, opts());

    const asked = host.calls.filter((cmd) => cmd[0] === "realpath").map((cmd) => cmd[3]);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.length).toBe(new Set(asked).size);
  });

  it("asks the host where a source really points, and refuses when it cannot say", async () => {
    // Fails closed: a host with no `realpath` refuses every mount rather than falling back to
    // the lexical answer, because that fallback is the escape the resolver exists to close.
    const missing: ResolveLinks = async () => {
      throw new ExecutorUnavailableError("would expose the host by guessing");
    };
    expect(await verdict(JAIL_ROOT, SRV, missing)).toBe("refused");

    const host = fakeHost(
      daemon([[/^realpath/, { exitCode: 127, stderr: "realpath: not found" }]]),
    );
    await expect(ensureContainer(host.executor, CONFIG, IDS, opts())).rejects.toThrow(
      /would expose the host/,
    );
    // Nothing was created for a container whose mounts could not be decided.
    expect(host.calls.some((cmd) => cmd[1] === "run")).toBe(false);

    // The other way a missing binary arrives: `Bun.spawn` raises ENOENT *synchronously*, so the
    // host executor rejects rather than returning 127 (`local.ts`). Both have to reach the
    // operator as the same refusal, not as an unhandled internal error.
    const enoent = fakeHost((cmd) => {
      if (cmd[0] === "realpath") throw new Error("ENOENT: no such file or directory, 'realpath'");
      return daemon()(cmd);
    });
    await expect(ensureContainer(enoent.executor, CONFIG, IDS, opts())).rejects.toThrow(
      /would expose the host/,
    );
    expect(enoent.calls.some((cmd) => cmd[1] === "run")).toBe(false);
  });

  it("tells the operator the rule the guard actually applies", async () => {
    /*
     * The one sentence an Owner ever reads about this, and it described the rule the rewrite
     * replaced: it said an agent is given "paths inside <content areas> or a home directory",
     * while a home directory's dot-half had become refused. So an Owner whose `local_path`
     * Repository is `~/.local/share/chezmoi` or `~/.dotfiles` was refused by a sentence telling
     * them home directories were allowed, and had nothing to act on. The docstring on
     * `guardMountSource` and F07 both already say "the work half of a home directory".
     */
    const refusal = await guardMountSource("/home/dev/.dotfiles", SRV, LEXICAL).catch(String);
    expect(refusal).toContain("the work half of a home directory");
    expect(refusal).not.toMatch(/(?:inside|or) a home directory/);
  });

  it("recognises the repository cache root because it is told it, not because of where it sits", async () => {
    /*
     * `SOLOW_REPO_CACHE_ROOT` is an independent absolute path (`env.ts`), and the guard used to
     * find it by taking `dirname(worktreeRoot)` — which admitted the whole parent directory
     * instead of the one sibling, and is how `/var/run` became mountable. It is passed
     * explicitly now: `factory.ts` already builds one options object carrying both roots for the
     * driver and its preflight, so nothing new has to be plumbed.
     *
     * `/cache` and nothing under it is reachable by any *other* rule — not a content area, not a
     * home, not below the worktree root — which is what makes the two assertions below about the
     * cache root at all. The first spelling of this test used `/mnt/big-disk/solow-repos`, and
     * `/mnt` is a content area: deleting `roots.repoCacheRoot` from the guard's loop left it
     * green, so it could not fail on the property it is named after.
     */
    const roots: MountRoots = {
      worktreeRoot: "/var/solow/worktrees",
      repoCacheRoot: "/cache/solow-repos",
    };
    expect(await guardMountSource("/cache/solow-repos", roots, LEXICAL)).toBe("/cache/solow-repos");
    expect(await guardMountSource("/cache/solow-repos/task-1", roots, LEXICAL)).toBe(
      "/cache/solow-repos/task-1",
    );
    // And being next door to a root buys nothing, which is the half of it that was the defect.
    await expect(guardMountSource("/var/anything-else", roots, LEXICAL)).rejects.toThrow(
      /would expose the host/,
    );
    // …nor is the cache root's own parent, which no rule reaches either.
    await expect(guardMountSource("/cache", roots, LEXICAL)).rejects.toThrow(
      /would expose the host/,
    );
  });

  it("guards the profile's own mounts and every bind path with the same roots", async () => {
    // The guard is only worth anything if `bindsFor` hands it what the operator supplied, so
    // this asserts the wiring rather than the arithmetic: an operator-set `mounts` source is
    // refused, and the cache root the executor was given is not.
    const host = fakeHost();
    const exposed: DockerExecutorConfig = {
      ...CONFIG,
      mounts: [{ source: "/var/run/docker.sock", target: "/var/run/docker.sock", readOnly: false }],
    };
    await expect(
      ensureContainer(host.executor, exposed, IDS, opts({ worktreeRoot: "/var/solow" })),
    ).rejects.toThrow(/would expose the host/);

    const ok = fakeHost();
    await ensureContainer(ok.executor, CONFIG, IDS, opts({ repoCacheRoot: "/var/solow/repos" }));
    const run = ok.calls.find((cmd) => cmd[1] === "run");
    expect(run?.join(" ")).not.toContain("docker.sock");
  });
});

describe("the prepare script", () => {
  const WITH_PREPARE: DockerExecutorConfig = {
    ...CONFIG,
    prepareScript: "apk add --no-cache curl",
  };

  it("runs as root, because omitting --user inherits the container's uid", async () => {
    const host = fakeHost();

    await runPrepareScript(host.executor, NAME, WITH_PREPARE.prepareScript ?? "", opts());

    // Omitting the flag was the bug, not the fix: a `docker exec` with no `--user` runs as the
    // user the container was *created* with, which the run line above pinned to `--user 1000:1000`
    // — so `apk add` failed with "Unable to open log: Permission denied" and every profile whose
    // prepare script installs a package failed at preflight rung 9.
    expect(host.calls.at(-1)).toEqual([
      "docker",
      "exec",
      "-i",
      "--user",
      "0:0",
      "-w",
      JAIL_ROOT,
      NAME,
      "sh",
      "-s",
    ]);
    // The script itself travels on stdin, never in argv, for the same reason the environment does.
    expect(host.stdin).toContain("apk add --no-cache curl");
  });

  it("carries the reason when the script reported it on stdout", async () => {
    const host = fakeHost(
      daemon([[/sh -s/, { exitCode: 4, stdout: "pip: not found\n", stderr: "" }]]),
    );
    const executor = createDockerExecutor(host.executor, WITH_PREPARE, IDS, opts());

    // stderr alone left the operator reading "the profile's prepare script failed (exit 4): "
    // with the half AC-6 requires missing — and a script that says what went wrong with `echo`
    // is not an exotic script.
    await expect(executor.exec(["true"])).rejects.toThrow(
      /prepare script failed \(exit 4\): pip: not found/,
    );
  });
});

describe("a verdict always carries a reason", () => {
  it("falls back to stdout, and then to saying there was none", () => {
    // The daemon normally diagnoses on stderr, which is why that is still first.
    expect(failureText({ stdout: "", stderr: "Cannot connect to the Docker daemon\n" })).toBe(
      "Cannot connect to the Docker daemon",
    );
    // `SOLOW_DOCKER_BIN=/bin/false` writes nothing at all; the em dash in "Docker is not
    // reachable — " must still be followed by something an operator can act on.
    expect(failureText({ stdout: "", stderr: "" })).toBe("no output");
    expect(failureText({ stdout: "manifest not found\n", stderr: "" })).toBe("manifest not found");
    // `lastLine` for a shell script, where the diagnosis is the last thing it managed to say.
    expect(failureText({ stdout: "step 1\nno such package\n", stderr: "" }, lastLine)).toBe(
      "no such package",
    );
  });

  it("reports what a container that could not be created actually failed on", async () => {
    /*
     * Verbatim from Docker 29.7.2, all four lines on stderr: `docker run` narrates the pull
     * attempt *before* it fails, so `firstLine` reported the progress notice and threw the
     * diagnosis away — and `lastLine` would report the usage hint, which is no better. The
     * operator was told "Unable to find image … locally", which describes a normal pull.
     */
    const RUN_FAILURE =
      "Unable to find image 'solow/agent:1' locally\n" +
      "docker: Error response from daemon: pull access denied for solow/agent, repository does not exist or may require 'docker login': denied: requested access to the resource is denied\n" +
      "\n" +
      "Run 'docker run --help' for more information\n";

    const host = fakeHost(daemon([[/^docker run /, { exitCode: 125, stderr: RUN_FAILURE }]]));
    const cause = await ensureContainer(host.executor, CONFIG, IDS, opts()).catch(
      (error: unknown) => error,
    );
    expect(cause).toBeInstanceOf(ExecutorUnavailableError);
    const reason = (cause as Error).message;
    expect(reason).toContain("pull access denied");
    // And which profile it was: the diagnosis names the *repository* without the tag, so the
    // image the Owner configured has to be named by us — see the throw site, and AC-6 in
    // `scripts/smoke-docker-executor.sh`, which asks for both halves.
    expect(reason).toContain(CONFIG.image);
    // Not merely "also mentions the diagnosis": the notice must be gone, because a reason that
    // leads with it reads as though the image were simply being fetched.
    expect(reason).not.toContain("Unable to find image");

    // The marker the CLI puts on its own fatal line is what finds it — not the English, which
    // differs by daemon version and locale — and it is stripped once found, exactly as
    // `firstLine` strips it.
    expect(diagnosisLine(RUN_FAILURE)).toBe(
      "Error response from daemon: pull access denied for solow/agent, repository does not exist or may require 'docker login': denied: requested access to the resource is denied",
    );
    // Nothing marked means nothing was buried: `docker pull` reports this same failure with no
    // prefix and no notice above it, and the first line is already the whole answer.
    expect(diagnosisLine("Error response from daemon: pull access denied\n")).toBe(
      "Error response from daemon: pull access denied",
    );
    expect(diagnosisLine("")).toBe("");
  });
});

describe("baseEnv — the environment the agent starts from", () => {
  /** The one `docker image inspect` the driver makes, answered with the image's declared env. */
  function withImageEnv(declared: string[]): FakeHost {
    return fakeHost(daemon([[/image inspect/, { stdout: `${JSON.stringify(declared)}\n` }]]));
  }

  it("puts HOME on the container's own tmpfs, never in the bind-mounted worktree", async () => {
    /*
     * The worktree is a host bind mount, so an image declaring no `HOME` — alpine, and most bun
     * and node images — used to give the agent a `$HOME` *on the host*: `.gitconfig`, `.npmrc`,
     * `~/.config/gh/hosts.yml` and an agent CLI's own token store were written there and
     * outlived the container. The worktree is deliberately kept after a hard failure, so they
     * persisted precisely in the runs nobody goes back to look at.
     */
    const host = withImageEnv([]);
    const base = await createDockerExecutor(host.executor, CONFIG, IDS, opts()).baseEnv();

    expect(base["HOME"]).toBe(CONTAINER_HOME);
    expect(base["HOME"]).not.toBe(JAIL_ROOT);

    // And stated as a property rather than as a path, because what makes it safe is not where it
    // is but that nothing bind-mounts it: the same run line is asked for its mounts, and the
    // tmpfs that backs `HOME` is on it instead.
    await ensureContainer(host.executor, CONFIG, IDS, opts());
    const run = host.calls.find((cmd) => cmd[1] === "run") ?? [];
    const sources = run.filter((arg) => arg.startsWith("type=bind,"));
    expect(sources.length).toBeGreaterThan(0);
    for (const bind of sources) expect(bind).not.toContain(`source=${base["HOME"]}`);
    expect(run).toContain(`${CONTAINER_HOME}:rw,exec,mode=0700,uid=1000,gid=1000,size=64m`);
  });

  it("leaves an image that declares its own HOME alone", async () => {
    // An image that names a `HOME` named a directory in its own filesystem on purpose, and the
    // driver's job is to describe the execution host rather than to overrule it.
    const host = withImageEnv(["HOME=/home/node", "PATH=/usr/local/bin:/usr/bin"]);
    const base = await createDockerExecutor(host.executor, CONFIG, IDS, opts()).baseEnv();

    expect(base["HOME"]).toBe("/home/node");
    expect(base["PATH"]).toBe("/usr/local/bin:/usr/bin");
  });
});

describe("exec — the command's answer, and the container's death", () => {
  it("returns a non-zero exit rather than throwing it", async () => {
    const host = fakeHost(daemon([[/sh -c exit 3/, { exitCode: 3, stderr: "oops\n" }]]));
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    const result = await executor.exec(["sh", "-c", "exit 3"]);

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("oops\n");
  });

  it("throws when the daemon says the container is gone", async () => {
    const host = fakeHost(
      daemon([
        [
          /test -e/,
          {
            exitCode: 1,
            stdout: "",
            stderr: "Error response from daemon: No such container: solow-abc\n",
          },
        ],
      ]),
    );
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    // Exit 1 with nothing on stdout is *also* what `test -e` returns for "the file is not
    // there". Reading the code alone would make a dead container answer `false` here,
    // `prepareRepository` would then raise the non-retryable `RepositoryUnusableError`, and the
    // Task would be permanently failed with an innocent Repository's name on it.
    await expect(executor.fs.exists("notes.txt")).rejects.toThrow(ExecutorUnavailableError);
    await expect(executor.fs.exists("notes.txt")).rejects.toThrow(/no longer running/);
  });

  it("reads a plain exit 1 with no daemon prefix as the command's own answer", async () => {
    const host = fakeHost(daemon([[/test -e/, { exitCode: 1, stdout: "", stderr: "" }]]));
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    expect(await executor.fs.exists("nope.txt")).toBe(false);
  });
});

describe("fs — the jail is enforced on the host, before the daemon is spoken to", () => {
  it("rejects a traversal without issuing a single docker command", async () => {
    const host = fakeHost();
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    // Not merely "it is rejected": rejected *before* the container is even created. The
    // container has no knowledge of the jail root and could not enforce it, so a check that ran
    // after the path had been handed to `docker exec` would be no check at all.
    await expect(executor.fs.readFile("../../etc/passwd")).rejects.toThrow(/escapes executor root/);
    await expect(executor.fs.exists("../outside.txt")).rejects.toThrow(/escapes executor root/);
    await expect(executor.fs.writeFile("../escape.txt", "x")).rejects.toThrow(
      /escapes executor root/,
    );
    expect(host.calls).toEqual([]);
  });

  it("writes content on stdin, through an exec that keeps its stdin open", async () => {
    const host = fakeHost();
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    await executor.fs.writeFile("nested/notes.txt", "secret content\n");

    const write = host.calls.find((cmd) => cmd.includes('cat > "$1"'));
    // `-i` is not optional and its absence is silent: without it the shim reads EOF, the file is
    // created **zero bytes**, and the exit code is 0.
    expect(write?.slice(0, 3)).toEqual(["docker", "exec", "-i"]);
    // The path travels as `$1` so a filename can never become shell syntax, and the content
    // travels on stdin so it never appears in argv at all.
    expect(write?.at(-1)).toBe(`${JAIL_ROOT}/nested/notes.txt`);
    expect(host.stdin).toContain("secret content\n");
    for (const cmd of host.calls) {
      expect(cmd.some((arg) => arg.includes("secret content"))).toBe(false);
    }
  });
});

describe("spawn — the environment, and the signal", () => {
  it("delivers the environment on stdin and never in argv", async () => {
    const host = fakeHost();
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    executor.spawn(["claude", "--print"], {
      cwd: JAIL_ROOT,
      env: { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-secret" },
    });

    const spawned = host.calls.find((cmd) => cmd.includes("claude"));
    // `env -i` is what makes `SpawnOpts.env` mean *replace*: `-e` and `--env-file` both merge
    // over the image's own `ENV`, so neither can express it.
    expect(spawned).toContain("env");
    expect(spawned).toContain("-i");
    expect(spawned?.some((arg) => arg.includes("sk-ant-oat01-secret"))).toBe(false);

    const preamble = host.stdin.find((chunk) => chunk.trim().length > 0);
    const decoded = Buffer.from((preamble ?? "").trim(), "base64").toString("utf8");
    expect(decoded).toContain("export 'CLAUDE_CODE_OAUTH_TOKEN'='sk-ant-oat01-secret'");
    expect(decoded).toContain("export 'PATH'='/usr/bin'");
  });

  it("escalates TERM to KILL against the pid inside the container", async () => {
    const host = fakeHost(daemon([[/cat \/run\/solow\//, { stdout: "4242\n" }]]));
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    const proc = executor.spawn(["sh", "-c", "sleep 30"], { cwd: JAIL_ROOT, env: {} });

    proc.kill();
    await waitFor(() => host.calls.some((cmd) => cmd.includes("TERM")), "the TERM signal");
    proc.kill("SIGKILL");
    await waitFor(() => host.calls.some((cmd) => cmd.includes("KILL")), "the KILL signal");

    // Signalled by pid, never by terminating the `docker exec` client: verified that killing the
    // client leaves the inner process running — one leaked agent per stop — while the pid route
    // makes the client exit 143 for TERM and 137 for KILL, which is what the ladder in
    // `packages/acp/src/session.ts` reads as "the polite signal was ignored".
    expect(host.calls).toContainEqual([
      "docker",
      "exec",
      "--user",
      USER,
      NAME,
      "kill",
      "-s",
      "TERM",
      "4242",
    ]);
    expect(host.calls).toContainEqual([
      "docker",
      "exec",
      "--user",
      USER,
      NAME,
      "kill",
      "-s",
      "KILL",
      "4242",
    ]);
  });

  it("throws synchronously for a command the preflight proved is missing", () => {
    const host = fakeHost();
    const executor = createDockerExecutor(
      host.executor,
      CONFIG,
      IDS,
      opts({ probedCommands: new Map([["claude", false]]) }),
    );

    // `probe.ts` and `claude-code-runner.ts` both wrap `spawn` in try/catch and depend on it
    // throwing here; Docker cannot answer that without a 270ms round trip, against a 400ms race
    // window. A command the preflight never saw falls through rather than being refused.
    expect(() => executor.spawn(["claude"], { cwd: JAIL_ROOT, env: {} })).toThrow(
      /"claude": not found in the executor image/,
    );
    expect(() => executor.spawn(["git"], { cwd: JAIL_ROOT, env: {} })).not.toThrow();
  });
});

describe("dispose", () => {
  it("removes the container, and says nothing the second time", async () => {
    const host = fakeHost();
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    await expect(executor.dispose()).resolves.toBeUndefined();
    await expect(executor.dispose()).resolves.toBeUndefined();

    // `docker rm -f` on a container that is already gone succeeds, so the second call is not a
    // special case in the driver — but the lifecycle's `finally` can genuinely run twice, and a
    // teardown that threw the second time would fail a Task that had already completed.
    expect(host.calls.filter((cmd) => cmd[1] === "rm")).toEqual([
      ["docker", "rm", "-f", NAME],
      ["docker", "rm", "-f", NAME],
    ]);
  });

  it("resolves even when the daemon itself has gone away", async () => {
    const host = fakeHost(() => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    });
    const executor = createDockerExecutor(host.executor, CONFIG, IDS, opts());

    // A daemon that has gone away has disposed of the container more thoroughly than we could.
    await expect(executor.dispose()).resolves.toBeUndefined();
  });
});
