import { afterEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeExecutorContract } from "./contract.js";
import {
  CONTAINER_HOME,
  containerName,
  containerNameFor,
  createDockerExecutor,
  type DockerExecutorConfig,
  type DockerExecutorOpts,
  type DockerIds,
  defaultContainerUser,
  deploymentId,
  guardMountSource,
  isExecutorUnavailable,
  isOpenTerminal,
  type ResolveLinks,
} from "./docker.js";
import { openOutOfBandExecutor } from "./factory.js";
import { createLocalExecutor } from "./local.js";
import type { Executor } from "./types.js";

/**
 * The cross-driver contract, against a real Docker daemon (issue #96, spec F07).
 *
 * `docker.test.ts` proves the driver composes the argv it means to; only this file proves that
 * argv does what the brief says it does. Every mechanism the driver rests on is a claim about
 * how the Docker CLI and a busybox shell actually behave — that `IFS= read -r` does not
 * over-consume the pipe and the harness's own stdin arrives intact, that `env -i` is what makes
 * `SpawnOpts.env` mean *replace*, that signalling the pid inside the container settles `exited`
 * where killing the client would not — and a fake host executor cannot contradict any of them.
 *
 * Opt-in, because it is the only test in the orchestrator that needs a daemon and a pullable
 * image: CI without one would fail on infrastructure rather than on code. `SOLOW_TEST_DOCKER=1`
 * is the switch, and the skipped case below is deliberately visible in the run's output — a file
 * that quietly registered nothing would look identical to one that had been deleted.
 */

const LIVE = process.env["SOLOW_TEST_DOCKER"] === "1";

/**
 * A small image that has the userland the shims need. Overridable because a machine behind a
 * private registry may not be able to reach Docker Hub, and the contract has nothing to say
 * about which image it runs in.
 */
const IMAGE = process.env["SOLOW_TEST_DOCKER_IMAGE"] ?? "alpine:3";

const CONFIG: DockerExecutorConfig = { kind: "docker", image: IMAGE, mounts: [], env: {} };

/**
 * One container per case, keyed by a distinct Task id.
 *
 * The contract calls its factory per test on purpose — a driver whose memoized container leaked
 * between cases would otherwise pass on the strength of the first one's setup — and the
 * container name is derived from the Task, so sharing an id here would have every case adopt or
 * tear down its neighbour's container.
 */
let sequence = 0;

async function liveHarness() {
  // The worktree root is the *parent* of the jail: the mount-source guard refuses any source
  // that is a proper ancestor of the worktree root, which a jail equal to it would not be, but
  // this is also the shape a real Task has — one worktree directory inside the shared root.
  const worktreeRoot = await mkdtemp(join(tmpdir(), "gc-docker-live-"));
  const root = join(worktreeRoot, `task-${sequence}`);
  await mkdir(root, { recursive: true });

  const executor = createDockerExecutor(
    // A real local executor as the host: this is exactly what `dockerHost()` builds in
    // production, so the live run exercises the composition and not a stand-in for it.
    createLocalExecutor(process.cwd()),
    CONFIG,
    { workspaceId: "ws-live", taskId: `task-${sequence++}`, sessionId: "sess-live" },
    { jailRoot: root, worktreeRoot, user: defaultContainerUser() },
  );

  /*
   * Create the container before the case runs, which is the order production has.
   *
   * `spawn` is synchronous by the interface, so it can only *kick* creation and hand back a
   * handle — and a `docker exec` that reaches the daemon first answers "No such container" on
   * stderr with an empty stdout. In a real run `step.run("executor-preflight")` has already
   * created it in its own durable step long before a harness is spawned; this one cheap `exec`
   * stands in for that step, rather than the contract quietly depending on a race.
   */
  const warm = await executor.exec(["true"]);
  if (warm.exitCode !== 0) {
    throw new Error(`could not start a live container from "${IMAGE}": ${warm.stderr.trim()}`);
  }

  return {
    executor,
    root,
    cleanup: async () => {
      // `dispose` never throws, so a failed case still gets its container removed — the reaper
      // is the net, not the plan.
      await executor.dispose();
      await rm(worktreeRoot, { recursive: true, force: true });
    },
  };
}

if (LIVE) {
  describeExecutorContract("docker", liveHarness);
  describeMountDifferential();
  describeOneShot();
  describeTerminal();
} else {
  describe("Executor contract — docker (live)", () => {
    it.skip("needs a Docker daemon: re-run with SOLOW_TEST_DOCKER=1", () => {});
  });
  describe("Mount differential — docker (live)", () => {
    it.skip("needs a Docker daemon: re-run with SOLOW_TEST_DOCKER=1", () => {});
  });
  describe("One-shot beside a Task — docker (live)", () => {
    it.skip("needs a Docker daemon: re-run with SOLOW_TEST_DOCKER=1", () => {});
  });
  describe("Terminal in a container — docker (live)", () => {
    it.skip("needs a Docker daemon: re-run with SOLOW_TEST_DOCKER=1", () => {});
  });
}

/**
 * The Task page's terminal, inside a container of its own (roadmap B4).
 *
 * `docker.test.ts` pins the argv; every claim that argv rests on is about the Docker CLI and a
 * TTY, and only a daemon can answer them: that `-e NAME` reads the value from the CLI's own
 * environment and never needs it in argv, that `env -i` then leaves exactly the caller's
 * variables (and none of the `TERM`/`HOSTNAME`/`HOME` an exec is otherwise given), that the
 * detach keys hold back nothing anyone types, that a resize reaches the program, that the exit
 * code comes through, and that `dispose()` takes the container and whatever is in it.
 */
function describeTerminal(): void {
  describe("Terminal in a container — docker (live)", () => {
    // Past every wait below together, so a case that fails reports its own assertion — and runs
    // its `finally` — rather than being cut off by the five-second default with its container up.
    const CASE_MS = 30_000;

    /** One program on the container's TTY, its output gathered as text. */
    function open(executor: Executor, cmd: string[], env: Record<string, string>) {
      let output = "";
      const handle = executor.openTerminal?.(cmd, {
        cwd: "/",
        env,
        cols: 80,
        rows: 24,
        onData: (data) => {
          output += new TextDecoder().decode(data);
        },
        onExit: () => {},
      });
      if (!handle) throw new Error("the Docker driver opened no terminal");
      const until = async (text: string) => {
        for (let i = 0; i < 250 && !output.includes(text); i++) await Bun.sleep(20);
        return output.includes(text);
      };
      return { handle, output: () => output, until };
    }

    async function terminalContainer() {
      const host = createLocalExecutor(process.cwd());
      const worktreeRoot = await mkdtemp(join(tmpdir(), "gc-docker-terminal-"));
      const root = join(worktreeRoot, "task-terminal");
      await mkdir(root, { recursive: true });
      const ids: DockerIds = {
        workspaceId: "ws-live",
        taskId: "task-terminal",
        sessionId: `conn-${randomBytes(4).toString("hex")}`,
      };
      const opts: DockerExecutorOpts = {
        jailRoot: root,
        worktreeRoot,
        user: defaultContainerUser(),
        role: "terminal",
      };
      const executor = createDockerExecutor(host, CONFIG, ids, opts);
      // Made the way the terminal's preflight makes it; the preflight itself wants an image with
      // the full userland, which `smoke-docker` exercises.
      expect((await executor.exec(["true"])).exitCode).toBe(0);
      return {
        executor,
        name: containerNameFor(ids, opts),
        docker: async (...args: string[]) => (await host.exec(["docker", ...args])).stdout.trim(),
        cleanup: async () => {
          await executor.dispose();
          await rm(worktreeRoot, { recursive: true, force: true });
        },
      };
    }

    it(
      "hands the program exactly its environment, never in the host's argv, and its exit code back",
      async () => {
        const box = await terminalContainer();
        try {
          const secret = `sk-live-${randomBytes(6).toString("hex")}`;
          const term = open(box.executor, ["sh", "-c", "env; read line; exit 7"], {
            PATH: "/usr/bin:/bin",
            SOLOW_LIVE_SECRET: secret,
          });
          expect(await term.until(`SOLOW_LIVE_SECRET=${secret}`)).toBe(true);
          const ps = Bun.spawnSync(["ps", "-eo", "args"]).stdout.toString();
          expect(ps).not.toContain(secret);

          term.handle.write("\r");
          expect(await term.handle.exited).toBe(7);
          const names = term
            .output()
            .split(/\r?\n/)
            .map((line) => line.split("=")[0])
            .filter((name) => name && /^[A-Z_]+$/.test(name));
          // `PWD` and `SHLVL` are the shell's own; nothing of the image's, the exec's or the
          // prefixed copies the CLI carried in.
          expect(new Set(names)).toEqual(new Set(["PATH", "SOLOW_LIVE_SECRET", "PWD", "SHLVL"]));
        } finally {
          await box.cleanup();
        }
      },
      CASE_MS,
    );

    it(
      "passes ctrl-p straight through, and tells the program it was resized",
      async () => {
        const box = await terminalContainer();
        try {
          const keys = open(
            box.executor,
            ["sh", "-c", "stty raw -echo; dd bs=1 count=1 2>/dev/null | od -An -tx1; stty sane"],
            { PATH: "/usr/bin:/bin" },
          );
          await Bun.sleep(500);
          keys.handle.write(new Uint8Array([0x10]));
          // Under the default detach keys this byte waits in the CLI for the next one.
          expect(await keys.until(" 10")).toBe(true);
          await keys.handle.exited;

          const resized = open(
            box.executor,
            ["sh", "-c", "trap 'stty size; exit 0' WINCH; echo ready; while :; do sleep 0.1; done"],
            { PATH: "/usr/bin:/bin" },
          );
          expect(await resized.until("ready")).toBe(true);
          resized.handle.resize(132, 40);
          expect(await resized.until("40 132")).toBe(true);
          expect(await resized.handle.exited).toBe(0);
        } finally {
          await box.cleanup();
        }
      },
      CASE_MS,
    );

    it(
      "hangs up, and dispose takes the container and what was left running in it",
      async () => {
        const box = await terminalContainer();
        try {
          const term = open(box.executor, ["sh", "-c", "echo up; while :; do sleep 1; done"], {
            PATH: "/usr/bin:/bin",
          });
          expect(await term.until("up")).toBe(true);
          expect(isOpenTerminal(box.name)).toBe(true);

          term.handle.kill();
          await term.handle.exited;
          await box.executor.dispose();

          expect(await box.docker("ps", "-aq", "--filter", `name=^${box.name}$`)).toBe("");
          expect(isOpenTerminal(box.name)).toBe(false);
        } finally {
          await box.cleanup();
        }
      },
      CASE_MS,
    );
  });
}

/**
 * A one-shot container — an Explain, or the setup's test — beside a live Task's (roadmap B4).
 *
 * `docker.test.ts` pins the argv that keeps the two apart; this asks the daemon whether it did:
 * the one-shot is a second container rather than the Task's adopted, it holds only its scratch
 * directory, and removing it leaves the Task's container running.
 */
function describeOneShot(): void {
  describe("One-shot beside a Task — docker (live)", () => {
    it("runs as its own container, holds only its scratch directory, and leaves the Task's running", async () => {
      // `dockerOpts` reads the deployment's settings, which refuse to parse without this.
      process.env["SOLOW_STREAM_SECRET"] ??= "docker-live-oneshot";
      const host = createLocalExecutor(process.cwd());
      const worktreeRoot = await mkdtemp(join(tmpdir(), "gc-docker-oneshot-"));
      const repoCacheRoot = await mkdtemp(join(tmpdir(), "gc-docker-oneshot-repos-"));
      const ids: DockerIds = { workspaceId: "ws-live", taskId: "task-oneshot", sessionId: "sess" };
      const taskRoot = join(worktreeRoot, "task-oneshot");
      await mkdir(taskRoot, { recursive: true });
      const taskExecutor = createDockerExecutor(host, CONFIG, ids, {
        jailRoot: taskRoot,
        worktreeRoot,
        user: defaultContainerUser(),
      });
      const taskName = containerName(ids, deploymentId(worktreeRoot));
      const docker = async (...args: string[]) =>
        (await host.exec(["docker", ...args])).stdout.trim();
      try {
        expect((await taskExecutor.exec(["true"])).exitCode).toBe(0);

        const launch = await openOutOfBandExecutor(
          { config: CONFIG },
          {
            workspaceId: ids.workspaceId,
            taskId: ids.taskId,
            purpose: "explain",
            harnessCommands: ["sh"],
            worktreeRoot,
            repoCacheRoot,
            host,
          },
        );
        // Created the way the driver creates it on first use; the preflight is the run's own and
        // is exercised by `smoke-docker`, against an image that carries the full userland.
        expect((await launch.executor.exec(["test", "-d", launch.cwd])).exitCode).toBe(0);
        const oneShots = await docker(
          "ps",
          "-q",
          "--filter",
          "label=solow.role=oneshot",
          "--filter",
          `label=solow.deployment=${deploymentId(worktreeRoot)}`,
        );
        expect(oneShots.split("\n").filter(Boolean)).toHaveLength(1);
        const mounts = JSON.parse(
          await docker("inspect", "-f", "{{json .Mounts}}", oneShots),
        ) as Array<{ Type: string; Source: string }>;
        expect(mounts.filter((m) => m.Type === "bind").map((m) => m.Source)).toEqual([launch.cwd]);
        // The Task's worktree is not in there, whatever the two containers share in labels.
        expect((await launch.executor.exec(["test", "-e", taskRoot])).exitCode).not.toBe(0);

        await launch.dispose();

        expect(await docker("ps", "-aq", "--filter", `id=${oneShots}`)).toBe("");
        expect(await docker("inspect", "-f", "{{.State.Running}}", taskName)).toBe("true");
      } finally {
        await taskExecutor.dispose();
        await rm(worktreeRoot, { recursive: true, force: true });
        await rm(repoCacheRoot, { recursive: true, force: true });
      }
    });
  });
}

/**
 * The mount differential: what the guard approved against what the daemon actually mounted.
 *
 * Every mount defect this driver has had was invisible to an argv-level test, because in each one
 * the argv was *exactly* what the guard decided and the daemon still mounted something else — a
 * comma in an Owner-supplied path opening a second `src=` inside Docker's CSV `--mount` value, and
 * a symlink under world-writable `/tmp` that `resolve()` cannot see through. A suite that asserts
 * the driver's decision back to itself agrees with both escapes. So the only question asked below
 * is the one no fake host can answer: inspect the container that was really created, and compare
 * its mount set against the set `guardMountSource` — the driver's own guard, not a copy of it —
 * says it approved.
 *
 * What it restates is the caller's *input*: which paths were handed in, which target each asked
 * for, which asked to be read-only. A bind the driver invents, drops, redirects or quietly makes
 * writable therefore shows up as a difference instead of being reproduced on both sides.
 *
 * **One field is not differential, and saying so is the point.** `approvedMounts` obtains the
 * expected `Source` by calling `guardMountSource` itself, so a defect *inside* that function is
 * mirrored into the expectation and the comparison agrees with it. Demonstrated: make the guard
 * `return dirname(path)` — which hands the container the whole content area instead of the
 * approved subdirectory — and the set comparison below stays green. The alternative, spelling the
 * approved paths out as literals, pins the author's reading of the guard rather than the guard,
 * and would have to be rewritten on any host where a rule canonicalises differently; that trade
 * was taken deliberately. What closes it is `docker.test.ts`, whose MOUNTABLE and REFUSED tables
 * assert the guard's return value directly against fixed inputs, and which does go red on that
 * mutation. Read the two files as one pair: the tables say the guard decides correctly, this file
 * says the daemon does what the guard decided.
 *
 * Every other field here — `Type`, `Destination`, `RW`, set membership, and the tmpfs list — is
 * independent of the guard and each was killed by its own mutation.
 */

/** The two `--tmpfs` mounts `runArgs` gives every container, and the only ones it may. */
const INTENDED_TMPFS = ["/run/solow", CONTAINER_HOME].sort();

/** The fields of a `docker inspect` `.Mounts` entry this suite reasons about. */
interface DaemonMount {
  Type: string;
  Source: string;
  Destination: string;
  RW: boolean;
}

/** One mount as the caller asked for it — never as the driver decided it. See the header. */
interface RequestedMount {
  /** The path as an Owner or the worktree manager supplies it: unnormalised, unchecked. */
  source: string;
  /** Where in the container it was asked for. Omitted means identical-path, as `bindsFor` has it. */
  target?: string;
  readOnly?: boolean;
}

interface MountPlan {
  /** Paths arriving as `DockerExecutorOpts.bindPaths` — a Task's worktrees and repositories. */
  binds?: RequestedMount[];
  /** Paths arriving as profile `mounts`, which alone may name a target of their own. */
  mounts?: RequestedMount[];
}

interface MountFixture {
  executor: Executor;
  host: Executor;
  /** The deterministic container name, so a case can ask the daemon whether one exists. */
  name: string;
  /** This case's Task id: the only thing that identifies its containers on a shared daemon. */
  taskId: string;
  config: DockerExecutorConfig;
  opts: DockerExecutorOpts;
  cleanup(): Promise<void>;
}

let mountCase = 0;

/**
 * A driver over a real local host, mounting what `plan` asks for — created, not yet started.
 *
 * `plan` is a callback rather than a value because most of these cases have to build something on
 * the host first — the symlink whose target escapes, the directories the accepted spellings
 * normalise onto — and each must build it inside a content area this fixture owns rather than at
 * a fixed path in `/tmp` that two concurrent runs would fight over.
 *
 * The container is deliberately **not** warmed here: half the cases assert that no container was
 * ever created, and a fixture that created one first could not tell a refusal from a teardown.
 */
async function mountFixture(
  plan: (content: string) => MountPlan | Promise<MountPlan>,
): Promise<MountFixture> {
  const worktreeRoot = await mkdtemp(join(tmpdir(), "solow-t-wt-"));
  /*
   * A second area, outside the deployment's own directories on purpose. A Repository is not
   * inside the worktree root, so it is admitted by the *content area* rule — the rule both known
   * escapes came through — and a fixture that put everything under `worktreeRoot` would exercise
   * the deployment-root rule instead, which lets anything below it through by design.
   */
  // `/tmp` literally, not `tmpdir()`: the guard admits this directory because `/tmp` is a
  // CONTENT_AREA, and `TMPDIR` is free to point somewhere that is not one — macOS's own
  // `/var/folders/…` is not, so a fixture built from `tmpdir()` there would have every accepted
  // spelling below refused and the suite would fail on the platform rather than on the code.
  const content = await mkdtemp("/tmp/solow-t-src-");
  const jailRoot = join(worktreeRoot, `task-${mountCase++}`);
  await mkdir(jailRoot, { recursive: true });

  const requested = await plan(content);
  const ids: DockerIds = {
    workspaceId: "ws-mount",
    // Random, not sequential: this suite shares a daemon with whatever else is running on the
    // machine, so "did a container appear" has to be asked about *this* case and nothing else.
    taskId: `mount-diff-${randomBytes(6).toString("hex")}`,
    sessionId: "sess-mount",
  };
  const config: DockerExecutorConfig = {
    kind: "docker",
    image: IMAGE,
    mounts: (requested.mounts ?? []).map((mount) => ({
      source: mount.source,
      target: mount.target ?? mount.source,
      readOnly: mount.readOnly ?? false,
    })),
    env: {},
  };
  const opts: DockerExecutorOpts = {
    jailRoot,
    worktreeRoot,
    bindPaths: (requested.binds ?? []).map((bind) => bind.source),
    user: defaultContainerUser(),
  };
  const host = createLocalExecutor(process.cwd());
  const executor = createDockerExecutor(host, config, ids, opts);

  return {
    executor,
    host,
    name: containerName(ids, deploymentId(worktreeRoot)),
    taskId: ids.taskId,
    config,
    opts,
    cleanup: async () => {
      // Unconditional, and it is the teardown for the refusal cases too: a case that failed
      // *because* a container it forbade was created must still take that container with it.
      await executor.dispose();
      await rm(worktreeRoot, { recursive: true, force: true });
      await rm(content, { recursive: true, force: true });
    },
  };
}

/** `docker inspect -f '{{json …}}'`, through the host executor like every other Docker call. */
async function inspectJson<T>(fixture: MountFixture, template: string): Promise<T> {
  const result = await fixture.host.exec(["docker", "inspect", "-f", template, fixture.name]);
  if (result.exitCode !== 0) {
    throw new Error(`docker inspect ${template} failed: ${result.stderr.trim()}`);
  }
  return JSON.parse(result.stdout) as T;
}

/**
 * The mount set the driver's guard approves for this fixture's inputs.
 *
 * `guardMountSource` is called rather than reimplemented, so what the guard normalises, refuses
 * or hands back moves this expectation with it — a test that spelled the approved paths out
 * would pin the author's reading of the guard rather than the guard. The resolver it needs is
 * the one line `hostResolveLinks` runs; that is not exported, and a differential cannot wait for
 * the module to hand it out.
 *
 * `bindsFor`'s ordering is not reproduced — the comparison sorts both sides. Its **dedup** is,
 * keyed on destination exactly as `bindsFor` keys on target. Not because the plans below need it
 * for their own sake, but because without it the accepted-spellings case passes for the wrong
 * reason: eight spellings of one directory collapse onto a single bind at the daemon, and an
 * expectation carrying eight duplicate entries then fails on the count whatever the driver did.
 * A test that goes red on arithmetic rather than on the property it names is the shape this whole
 * suite exists to avoid.
 */
async function approvedMounts(fixture: MountFixture): Promise<DaemonMount[]> {
  const resolveLinks: ResolveLinks = async (path) => {
    const answer = await fixture.host.exec(["realpath", "-m", "--", path]);
    if (answer.exitCode !== 0) throw new Error(`realpath -m -- ${path}: ${answer.stderr.trim()}`);
    return answer.stdout.trim();
  };

  const requested: RequestedMount[] = [
    { source: fixture.opts.jailRoot },
    ...(fixture.opts.bindPaths ?? []).map((source) => ({ source })),
    ...fixture.config.mounts,
  ];
  // Keyed on destination, because that is what `bindsFor` keys on: two requests landing on one
  // target are one mount at the daemon, and the last writer wins there as it does here.
  const approved = new Map<string, DaemonMount>();
  for (const mount of requested) {
    const source = await guardMountSource(mount.source, fixture.opts, resolveLinks);
    // Identical-path for a `bindPaths` entry, because `bindsFor` has no choice there (a
    // worktree's `.git` names its gitdir by absolute host path); a profile mount names its own.
    const destination = mount.target ?? source;
    approved.set(destination, {
      Type: "bind",
      Source: source,
      Destination: destination,
      RW: mount.readOnly !== true,
    });
  }
  return [...approved.values()];
}

const byDestination = (a: DaemonMount, b: DaemonMount): number =>
  a.Destination < b.Destination ? -1 : 1;

/**
 * The whole invariant in one place: the daemon mounted the approved set, and nothing else.
 *
 * Three claims. The first compares the two mount sets whole rather than looking up the mounts it
 * expected, and that is the difference between catching both known escapes and neither: each of
 * them left every approved mount intact and *added* one, so a lookup would have passed with the
 * host root bound read-write beside them. `Type` travels in the compared tuple for the same
 * reason — a volume or a tmpfs spliced into a `--mount` value is an entry nothing else here
 * would question.
 *
 * The inode comparison is the only claim here that reads the mount rather than the daemon's
 * description of it, and it is here because that description is not the whole truth: `.Source`
 * is the string that was *asked for*, not the directory the daemon resolved it to — verified on
 * 29.7.2, where binding a symlink reports the link's own path and mounts its target. So this
 * asks the kernel on both sides whether the destination inside the container really is the
 * directory the host reaches at the approved source (`-L`, because the daemon dereferences and
 * GNU `stat` by default does not). What it does **not** do is catch a symlink escape: a link to
 * `/` resolves the same way on both sides, and the only thing that closes that case is the
 * refusal below.
 */
async function expectDaemonAgrees(fixture: MountFixture): Promise<void> {
  const approved = (await approvedMounts(fixture)).sort(byDestination);
  const actual = await inspectJson<DaemonMount[]>(fixture, "{{json .Mounts}}");

  expect(
    actual
      .map(({ Type, Source, Destination, RW }) => ({ Type, Source, Destination, RW }))
      .sort(byDestination),
  ).toEqual(approved);

  // The second claim. A `--tmpfs` mount does not appear in `.Mounts` at all (verified on 29.7.2),
  // so an unapproved one is invisible above and visible only here.
  const tmpfs = await inspectJson<Record<string, string> | null>(
    fixture,
    "{{json .HostConfig.Tmpfs}}",
  );
  expect(Object.keys(tmpfs ?? {}).sort()).toEqual(INTENDED_TMPFS);

  for (const mount of approved) {
    const onHost = await fixture.host.exec(["stat", "-L", "-c", "%i", mount.Source]);
    const inside = await fixture.executor.exec(["stat", "-L", "-c", "%i", mount.Destination]);
    expect(onHost.exitCode).toBe(0);
    expect(`${mount.Destination} -> ${inside.stdout.trim()}`).toBe(
      `${mount.Destination} -> ${onHost.stdout.trim()}`,
    );
  }
}

/**
 * The driver refused, and the daemon was never asked for anything.
 *
 * "It threw" is the weaker half and on its own it is not the property: the CSV injection threw
 * nothing at all, and a guard that removed a container after creating it would still have handed
 * the host over for as long as that container lived. So the daemon is asked whether one exists —
 * by this case's own Task label *and* by the deterministic name, because a container created
 * under an unintended name would still carry the labels and one created outside the label scheme
 * would still carry the name.
 */
async function expectRefusedWithNoContainer(fixture: MountFixture): Promise<void> {
  const attempt = await fixture.executor.exec(["true"]).then(
    () => undefined,
    (cause: unknown) => cause,
  );

  // The container question is asked **first**, and deliberately: an assertion on the error would
  // otherwise fail before this one ever ran, and "no container exists" is the half that carries
  // the security property. A guard that reported a refusal it had not actually performed reads
  // identically to a working one until this line.
  const listed = await fixture.host.exec([
    "docker",
    "ps",
    "-a",
    "--no-trunc",
    "--format",
    '{{.Names}}\t{{.Label "solow.task"}}',
  ]);
  expect(listed.exitCode).toBe(0);
  expect(
    listed.stdout
      .split("\n")
      .filter((line) => line.includes(fixture.name) || line.includes(fixture.taskId)),
  ).toEqual([]);

  expect(isExecutorUnavailable(attempt)).toBe(true);
}

/**
 * Spellings the guard must **refuse**, each named by what it would cost to accept.
 *
 * Every one is run end to end through `ensureContainer` rather than against `guardMountSource`
 * directly, because the property is not "the guard returns false" — it is that no container
 * exists afterwards.
 */
const REFUSED: { name: string; source: (content: string) => string }[] = [
  {
    name: "a symlink under a content area whose target is the host root",
    source: (content) => join(content, "link-to-root"),
  },
  {
    name: "a comma opening a second `src=` inside the `--mount` value",
    source: (content) => `${join(content, "repo")},src=/var/run`,
  },
  {
    name: "a comma carrying a whole second mount, source and target",
    source: () => "/srv/repos/app,src=/,dst=/hostfs",
  },
  {
    // Not coverage of `MOUNT_CSV_CHARS`' quote clause, and it must not be read as any: with the
    // whole bind-source check removed this row stays green, because the Docker CLI refuses the
    // value first — `parse error on line 1, column 35: bare " in non-quoted-field`, exit 125, no
    // container. It is kept as a daemon backstop, pinning that the CLI's refusal is the outcome
    // even if the guard ever stops being the thing that produces it. The quote clause itself is
    // covered where it can fail, against the guard's return value, in `docker.test.ts`.
    name: "a double quote — refused by the guard, and by the CLI behind it",
    source: (content) => join(content, 'a"b'),
  },
  {
    name: "a relative path, which `resolve()` would complete from the orchestrator's own cwd",
    source: () => "relative/path",
  },
  {
    name: "an empty path, which resolves to the orchestrator's own checkout",
    source: () => "",
  },
  {
    name: "`..` segments that climb out of the content area",
    source: (content) => `${content}/../../etc`,
  },
  {
    // Same shape as the quote row above: with `isMountable` forced true this stays green, because
    // binds here are identical-path, so the daemon rejects the *destination* — `invalid mount
    // config for type "bind": invalid specification: destination can't be '/'`, exit 125. The
    // allow-list's root rule is covered against the guard's return value in `docker.test.ts`.
    name: "the host root itself — refused by the guard, and by the daemon behind it",
    source: () => "/",
  },
  { name: "a whole content area rather than a path inside it", source: () => "/tmp" },
  { name: "the host's own directories", source: () => "/etc" },
];

/**
 * Spellings the guard must **accept**, with the path each normalises to.
 *
 * A guard that refused everything would pass every case above and be useless, and these are also
 * where the daemon gets a chance to disagree about a path it *did* mount: a space, a backslash
 * and a single quote all survive Docker's CSV reader as themselves (verified on 29.7.2), and the
 * symlink is the shape the guard exists to allow — one that lands inside the area it started in.
 */
const ACCEPTED: { name: string; spelling: (content: string) => string; real: string }[] = [
  {
    name: "a doubled separator",
    spelling: (content) => `${content}//doubled`,
    real: "doubled",
  },
  {
    name: "a trailing separator",
    spelling: (content) => `${join(content, "trailing")}/`,
    real: "trailing",
  },
  { name: "a `.` segment", spelling: (content) => `${content}/./dot`, real: "dot" },
  {
    name: "`..` segments that stay inside the area",
    spelling: (content) => `${content}/climb/../dotdot`,
    real: "dotdot",
  },
  { name: "whitespace in a path", spelling: (content) => join(content, "a b"), real: "a b" },
  { name: "a backslash in a path", spelling: (content) => join(content, "a\\b"), real: "a\\b" },
  { name: "a single quote in a path", spelling: (content) => join(content, "q'z"), real: "q'z" },
  {
    name: "a symlink whose target lands inside the same content area",
    spelling: (content) => join(content, "link-inside"),
    real: "link-inside",
  },
];

function describeMountDifferential(): void {
  describe("Mount differential — docker (live)", () => {
    let fixture: MountFixture | undefined;

    afterEach(async () => {
      const current = fixture;
      fixture = undefined;
      // Swallowed: a case that already failed must report its own reason, not a teardown error.
      if (current) await current.cleanup().catch(() => {});
    });

    async function fresh(plan: Parameters<typeof mountFixture>[0]): Promise<MountFixture> {
      fixture = await mountFixture(plan);
      return fixture;
    }

    /** Start the container the way production does — `ensureContainer` behind one cheap `exec`. */
    async function warm(current: MountFixture): Promise<void> {
      const result = await current.executor.exec(["true"]);
      if (result.exitCode !== 0) {
        throw new Error(
          `could not start a live container from "${IMAGE}": ${result.stderr.trim()}`,
        );
      }
    }

    it("mounts exactly the set the guard approved, and nothing else", async () => {
      const current = await fresh(async (content) => {
        await mkdir(join(content, "repo"), { recursive: true });
        await mkdir(join(content, "cache"), { recursive: true });
        return {
          binds: [{ source: join(content, "repo") }],
          // A profile mount, because it is the only shape that carries a target of its own and
          // the only one that can be read-only — the two halves of the invariant a `bindPaths`
          // entry cannot exercise at all.
          mounts: [{ source: join(content, "cache"), target: "/opt/cache", readOnly: true }],
        };
      });
      await warm(current);
      await expectDaemonAgrees(current);
    });

    describe("refused before any container exists", () => {
      for (const refused of REFUSED) {
        it(`refuses ${refused.name}`, async () => {
          const current = await fresh(async (content) => {
            await mkdir(join(content, "repo"), { recursive: true });
            // The escape that reached the host root on 29.7.2: `/tmp` is a content area and it
            // is world-writable, so anyone can leave this link where a Repository path points.
            await symlink("/", join(content, "link-to-root"));
            return { binds: [{ source: refused.source(content) }] };
          });
          await expectRefusedWithNoContainer(current);
        });
      }

      it("refuses a comma in a profile mount's *target*, which nothing used to guard", async () => {
        const current = await fresh(async (content) => {
          await mkdir(join(content, "cache"), { recursive: true });
          // The source is impeccable and the target carries the injection: this is the half of
          // the CSV escape that had no check at all, and it overrode the source the guard had
          // just approved with the host root.
          return {
            mounts: [{ source: join(content, "cache"), target: "/data,src=/,dst=/hostfs" }],
          };
        });
        await expectRefusedWithNoContainer(current);
      });
    });

    it("accepts the spellings a real deployment produces, and the daemon agrees", async () => {
      const current = await fresh(async (content) => {
        for (const accepted of ACCEPTED) {
          if (accepted.real !== "link-inside") {
            await mkdir(join(content, accepted.real), { recursive: true });
          }
        }
        await mkdir(join(content, "link-target"), { recursive: true });
        await symlink(join(content, "link-target"), join(content, "link-inside"));
        // One container for the whole table: every spelling normalises to a distinct directory,
        // so they can be mounted side by side, and a sweep that paid for a container per row
        // would cost a minute on every push for no extra coverage.
        return { binds: ACCEPTED.map((accepted) => ({ source: accepted.spelling(content) })) };
      });
      await warm(current);
      await expectDaemonAgrees(current);
    });
  });
}
