import { basename, isAbsolute } from "node:path";
import {
  type CommandProbes,
  type DockerExecutorConfig,
  type DockerExecutorOpts,
  type DockerIds,
  type ExecutorUnavailableError,
  ensureContainer,
  failureText,
  isExecutorUnavailable,
  lastLine,
  probeCommands,
  probeHostResolver,
  REQUIRED_CONTAINER_UTILITIES,
  runPrepareScript,
} from "./docker.js";
import type { Executor } from "./types.js";

/**
 * The Docker executor's preflight (issue #96, spec F07 AC-6).
 *
 * Called from **one** `step.run("executor-preflight")` placed immediately after the `hasDriver`
 * gate and therefore **before `prepare-repository` clones anything**. That placement is what
 * actually satisfies F07's "if a Container cannot be provisioned, the Task fails before starting
 * the Agent, with an actionable message": a probe that ran after the clone would have already
 * spent a minute of an operator's time proving the image does not exist.
 *
 * Every `ok: false` reason below is the literal `failureReason` an operator reads on the board,
 * so each one names the condition and, where the daemon said something useful, quotes it. The
 * rungs are ordered so the cheapest and most fundamental question is asked first — a host with no
 * `docker` at all must not first spend ten minutes pulling an image.
 *
 * The distinction the whole file turns on: an `ok: false` is a **verdict** (nothing about a retry
 * would change it, so the Task is failed with a reason), while a thrown error is a **flake** (a
 * pull that ran out of time, a daemon that blipped) which Inngest should retry. Collapsing the
 * two would either fail Tasks on a slow network or retry an image name that will never exist.
 */

export interface PreflightOpts extends DockerExecutorOpts {
  /** `SOLOW_REPO_CACHE_ROOT`. Checked for absoluteness alongside the worktree root (rung 0). */
  repoCacheRoot: string;
  /**
   * The commands this Task is going to `spawn` — the agent's own launch command. Probed once
   * here so `spawn` can throw synchronously for a missing binary; see `CommandProbes`.
   */
  agentCommands?: readonly string[];
  /** `SOLOW_DOCKER_PULL_TIMEOUT_MS`. */
  pullTimeoutMs?: number;
}

export type PreflightResult = { ok: true; agentCommands: string[] } | { ok: false; reason: string };

export async function probeExecutor(
  host: Executor,
  config: DockerExecutorConfig,
  ids: DockerIds,
  opts: PreflightOpts,
): Promise<PreflightResult> {
  const bin = opts.dockerBin ?? "docker";
  const docker = (args: string[]) => host.exec([bin, ...args]);

  /*
   * Rung 0 — the paths in argv have to be absolute.
   *
   * `resolve()` here would not be enough, because the mount has to match what *every other*
   * module puts in argv: `manager.ts`, `scm-ops.ts` and `setup-files.ts` all pass paths straight
   * through. A relative root resolves against the orchestrator's cwd on the host and against the
   * image's `WORKDIR` in the container, and the worktree would simply not be where the agent
   * looks. The default is `.solow/worktrees` (env.ts), so this is the common misconfiguration
   * rather than an exotic one.
   */
  const relative = [opts.worktreeRoot, opts.repoCacheRoot].find((path) => !isAbsolute(path));
  if (relative !== undefined) {
    return {
      ok: false,
      reason: `the Docker executor needs absolute paths: set SOLOW_WORKTREE_ROOT and SOLOW_REPO_CACHE_ROOT to absolute directories (got "${relative}")`,
    };
  }

  try {
    // Rung 1 — is there a daemon at all. `forward()` asks `dockerDaemonIsLocal()` the same
    // question at call time rather than being handed the answer from here: one definition of
    // "local daemon", not a recorded flag that can go stale against a changed `DOCKER_HOST`.
    const version = await docker(["version", "--format", "{{.Server.Version}}"]);
    if (version.exitCode !== 0) {
      // `failureText`, not `firstLine(version.stderr)`: a daemon that answers on stdout, or a
      // `SOLOW_DOCKER_BIN` wrapper that says nothing at all, rendered this verdict as a dangling
      // em dash — and the reason is the half of it AC-6 actually requires.
      return { ok: false, reason: `Docker is not reachable — ${failureText(version)}` };
    }

    /*
     * Rung 2 — the host utility the mount guard is built on, asked once about the host rather
     * than once per path.
     *
     * `hostResolveLinks` puts every bind source *and* every allow-list rule through
     * `realpath -m`, and fails closed. So a host whose `realpath` does not understand `-m`
     * refuses every mount there is, and the Task would otherwise die at rung 5 naming one path,
     * sending an operator to look at that path instead of at their userland. busybox's does not
     * (verified on 29.7.2: `realpath: -m: No such file or directory`, exit 1); whether the BSD
     * one macOS ships does was not established, which is the reason this asks the host rather
     * than deciding from a platform name.
     *
     * After rung 1 because a host with no Docker at all should hear about Docker first, and
     * before everything below it because this is one fork against a `docker pull` that can spend
     * minutes proving nothing.
     */
    const resolver = await probeHostResolver(host);
    if (resolver !== undefined) return { ok: false, reason: resolver };

    /*
     * Rung 3 — can this kernel actually enforce the limits, asked only when the profile set any.
     *
     * The field is `.CPUCfsQuota`, **not** `.CpuCfsQuota`: verified that the latter fails the
     * template outright with "can't evaluate field CpuCfsQuota in type system.dockerInfo", which
     * would have turned a capability check into an unconditional failure. Reporting an isolation
     * the operator did not get is the same class of lie the `hasDriver` gate exists to prevent,
     * so an unenforceable limit fails the Task rather than being dropped.
     */
    if (config.cpus !== undefined || config.memoryMb !== undefined) {
      const info = await docker([
        "info",
        "--format",
        "{{.MemoryLimit}} {{.SwapLimit}} {{.CPUCfsQuota}}",
      ]);
      if (info.exitCode !== 0) {
        /*
         * Asked before the fields are read, because an unread exit code turns "I could not find
         * out" into three confident diagnoses: an empty stdout splits into empty fields, none of
         * them is `"true"`, and every limit the profile asked for is reported unsupported.
         * Verified live with a `SOLOW_DOCKER_BIN` wrapper failing only `info` on a host whose
         * real `docker info` answers `true true true` — the Task failed naming the kernel, which
         * is not the subsystem at fault and not one the operator can go and fix.
         *
         * A verdict rather than a throw, in idiom with rung 1: `docker version` already proved
         * the daemon answers, so an `info` that does not is a standing condition of this host
         * (a permission or a proxy), not a blip a retry would get past.
         */
        return {
          ok: false,
          reason: `could not read this Docker host's limit support — ${failureText(info)}`,
        };
      }
      const [memoryLimit, swapLimit, cpuQuota] = info.stdout.trim().split(/\s+/);
      const unsupported: string[] = [];
      if (config.memoryMb !== undefined && memoryLimit !== "true") {
        unsupported.push("memory limit unsupported by the kernel");
      }
      if (config.memoryMb !== undefined && swapLimit !== "true") {
        unsupported.push("swap limit unsupported by the kernel");
      }
      if (config.cpus !== undefined && cpuQuota !== "true") {
        unsupported.push("CPU quota unsupported by the kernel");
      }
      if (unsupported.length > 0) {
        return {
          ok: false,
          reason: `this Docker host cannot enforce the limits this profile asks for (${unsupported.join(", ")})`,
        };
      }
    }

    // Rung 4 — the image, pulled once if the daemon does not already have it.
    const present = await docker(["image", "inspect", config.image, "--format", "{{.Id}}"]);
    if (present.exitCode !== 0) {
      /*
       * A pull that *times out* throws rather than returning a verdict, so Inngest retries a slow
       * network instead of failing the Task over one. Nothing aborts the `docker pull` itself —
       * there is no cancellation channel through the `Executor` — and that is deliberate: the
       * layer it already downloaded is in the daemon's cache, so the retry resumes rather than
       * starting again.
       */
      const pulled = await withTimeout(
        docker(["pull", config.image]),
        opts.pullTimeoutMs ?? 600_000,
        `pulling image "${config.image}" took longer than the pull timeout`,
      );
      if (pulled.exitCode !== 0) {
        return {
          ok: false,
          reason: `could not obtain image "${config.image}" — ${failureText(pulled)}`,
        };
      }
    }

    // Rungs 5-7 — the mount-source guard, the bind sources, adoption or creation, and the check
    // that what was created is actually running. All of it is `ensureContainer`'s, so the driver
    // rebuilding a container mid-run gets exactly the same guarantees as the preflight does.
    const { name } = await ensureContainer(host, config, ids, opts);

    /**
     * A verdict from rung 8 or 9, with the container that produced it removed alongside.
     *
     * `ensureContainer` states the invariant for itself — "a preflight that failed must never
     * leave a container behind for the reaper to explain later" — and these two rungs are the
     * only ones that can fail *after* it handed one back. Verified live that without this,
     * `probeExecutor` on `alpine:3` (no `git`) returned its verdict with the container still
     * `running`; production was clean only because `task-run.ts`'s `finally` disposes an executor
     * this exported function does not build, so any other caller leaked one per failed probe.
     * The driver's own `ready()` already does exactly this on the same prepare-script failure.
     *
     * `rm -f`'s exit code is deliberately not consulted: the verdict in hand is the one the
     * operator needs, and replacing it with "and the cleanup also failed" would name the wrong
     * problem. What the removal does buy is that the next pass rebuilds rather than adopting a
     * half-prepared container and skipping the script that failed on it.
     */
    const withoutContainer = async (reason: string): Promise<PreflightResult> => {
      await docker(["rm", "-f", name]);
      return { ok: false, reason };
    };

    /*
     * Rung 8 — the userland the shims need.
     *
     * `command -v sh env cat find …` in one call is **not** this probe, however natural it
     * reads: verified against busybox that it answers about its first argument only and exits 0,
     * so an image missing `git`, `find` and `base64` sails through it. `probeCommands` asks about
     * each one separately for exactly that reason.
     */
    const utilities = await probeCommands(host, name, REQUIRED_CONTAINER_UTILITIES, opts);
    const missing = REQUIRED_CONTAINER_UTILITIES.filter((tool) => utilities.get(tool) === false);
    if (missing.length > 0) {
      return withoutContainer(
        `image "${config.image}" is missing utilities the executor needs: ${missing.join(", ")}`,
      );
    }

    /*
     * Rung 9 — the profile's prepare script, after the userland probe rather than before it: a
     * prepare script failing on an image with no `sh` reports the script's exit code when the
     * real answer is that the image is unusable.
     */
    if (config.prepareScript) {
      const prepared = await runPrepareScript(host, name, config.prepareScript, opts);
      if (prepared.exitCode !== 0) {
        return withoutContainer(
          `the profile's prepare script failed (exit ${prepared.exitCode}): ${failureText(prepared, lastLine)}`,
        );
      }
    }

    /*
     * Rung 10 — what the Task is about to spawn, recorded rather than judged.
     *
     * A missing agent binary is not failed here. `spawn` throwing `"claude": not found in the
     * executor image` lands on the line `probe.ts` and `claude-code-runner.ts` already guard,
     * which produces the same operator-facing failure with the run's own context attached — and
     * it keeps this rung from failing a Task whose agent command the catalog spells in a way this
     * probe cannot resolve.
     */
    const agentCommands = (opts.agentCommands ?? []).filter(Boolean);
    const probes: CommandProbes = opts.probedCommands ?? new Map();
    for (const [command, found] of await probeCommands(host, name, agentCommands, opts)) {
      probes.set(command, found);
    }
    return { ok: true, agentCommands: agentCommands.filter((c) => probes.get(c) === true) };
  } catch (cause) {
    // A verdict the driver already phrased for an operator (an unsafe mount source, a container
    // that exited immediately) — passed through rather than re-worded here, so the failure text
    // has one author. Asked **first**, and that order is the fix: this class is the one carrying
    // the image's own words, so any diagnosis made ahead of it is a diagnosis made about text a
    // container chose.
    if (isExecutorUnavailable(cause)) {
      return { ok: false, reason: (cause as ExecutorUnavailableError).message };
    }
    if (isDockerMissing(cause, bin)) {
      // The host executor throws rather than returning: `Bun.spawn` raises ENOENT synchronously
      // for a binary that is not on `PATH`, so this never arrives as an exit code.
      return {
        ok: false,
        reason: 'Docker is not available on this host: the "docker" command was not found',
      };
    }
    // Anything else is a flake, and Inngest's retry is the right answer to it.
    throw cause;
  }
}

/**
 * ENOENT for the `docker` binary itself, decided on the error's structure and never on its words.
 *
 * The free-text match this replaces (`/ENOENT|No such file or directory|executable file not
 * found/i` against the message) was spoofable by the *container*: `ensureContainer` quotes an
 * image's own output into its error, and verified live on Docker 29.7.2 that
 * `hashicorp/terraform-mcp-server:0.2.3` dies with `exec /bin/sh failed: No such file or
 * directory`, which this function then read as a missing Docker — sending an operator to install
 * Docker on a host already answering `Docker version 29.7.2`. `code` and `path` come from the
 * spawn that failed, so nothing running inside a container can write either of them.
 *
 * `path` is checked because it is the argv[0] the spawn failed on, and `docker` is not the only
 * binary this file's host executor is asked for: `ensureContainer` pre-creates the bind sources
 * with `mkdir`, and a host missing *that* is a flake for Inngest to retry, not a report that
 * Docker is uninstalled. An executor that throws ENOENT without naming a path (an SSH or cloud
 * host relaying one) is still believed, since `docker` is all this function ever spawns itself.
 */
function isDockerMissing(cause: unknown, bin: string): boolean {
  const error = cause as { code?: unknown; path?: unknown } | null;
  if (error?.code !== "ENOENT") return false;
  return typeof error.path === "string" ? basename(error.path) === basename(bin) : true;
}

/** Bound a step that has no cancellation channel of its own; see rung 4. */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
