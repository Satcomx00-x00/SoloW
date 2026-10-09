import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExecutorConfig } from "@solow/contracts";
import { type OrchestratorEnv, orchestratorEnv } from "../env.js";
import {
  type CommandProbes,
  type ContainerRole,
  createDockerExecutor,
  type DockerIds,
  defaultContainerUser,
} from "./docker.js";
import { missingDriverReason } from "./drivers.js";
import { createLocalExecutor } from "./local.js";
import { type PreflightOpts, type PreflightResult, probeExecutor } from "./preflight.js";
import type { Executor } from "./types.js";

/**
 * Executor Profile → driver (issue #96, spec F07 AC-5). The one switch that turns a stored
 * configuration into somewhere a harness can actually run.
 *
 * Shaped exactly like `createHarnessRunner`'s protocol switch, and for the same reason: an
 * exhaustive `switch` over the discriminated union makes a fifth Executor kind a **compile
 * error** here rather than a silent fall-through to local — which would be the precise failure
 * `drivers.ts` exists to prevent, an operator asking for isolation, not getting it, and being
 * told the Task succeeded.
 *
 * `defaultDeps()` builds one executor for the whole lifecycle before the Task's profile is known;
 * this is what lets it build the *right* one afterwards instead.
 */

export interface ExecutorFactoryOpts {
  /** Which Task, in which Workspace, on which run — the container's labels (`DockerIds`). */
  ids: DockerIds;
  /**
   * The Task's primary worktree directory: the container driver's `fs` jail and its default
   * working directory.
   *
   * Deliberately *not* what the local driver is given, which is `SOLOW_WORKTREE_ROOT` — the root
   * it is handed once per process, before any Task exists. A container executor is per-Task by
   * construction and can afford the tighter jail. Nothing observes the difference today (`fs`
   * has no production consumer yet); when #33's file tree or #52's `.env` copy becomes one, the
   * two drivers should be given the same root by the caller rather than each keeping its own.
   */
  jailRoot: string;
  /** `SOLOW_WORKTREE_ROOT`, absolute. Identifies the deployment and bounds the mount guard. */
  worktreeRoot: string;
  /** `SOLOW_REPO_CACHE_ROOT`, absolute. Checked by the preflight's first rung. */
  repoCacheRoot: string;
  /** Host directories bind-mounted at their own path: the Task's worktrees and repositories. */
  bindPaths?: string[];
  /** The Task's harness transcript store on the host, mounted as the container's `.claude/projects`. */
  transcriptStore?: string;
  /**
   * The Task's checkpoint store (`checkpointStorePath`), mounted at its own path so the hook the
   * launch settings name by absolute path is the file the container runs. Local runs share the
   * filesystem and need nothing.
   */
  checkpointStore?: string;
  /** What this Task will `spawn`, so the preflight can prove it exists before the harness starts. */
  harnessCommands?: readonly string[];
  /**
   * Filled by the preflight, read synchronously by `spawn`.
   *
   * Build **one** map and pass **one** `ExecutorFactoryOpts` object to both this factory and
   * `probeExecutor`: they share the map by reference, and two separately-defaulted maps would
   * leave `spawn` consulting one nothing ever wrote to.
   */
  probedCommands?: CommandProbes;
  /**
   * How the driver reaches the daemon. Defaults to a local executor, which is what makes
   * "exactly one file touches the host" still true with a container driver in the tree — and
   * injectable so the driver can be tested against a fake that only records argv.
   */
  host?: Executor;
  /** A Task's own container unless stated — see `ContainerRole` and `openOutOfBandExecutor`. */
  role?: ContainerRole;
}

export function createExecutorFor(
  profile: { config: ExecutorConfig },
  opts: ExecutorFactoryOpts,
): Executor {
  // The configuration, not the denormalised `kind` column: the schema states that the config is
  // the source of truth and the column is derived from it on every write, so reading the column
  // here would be trusting the copy over the original.
  const config = profile.config;
  switch (config.kind) {
    case "local":
      // The worktree root, exactly as `defaultDeps()` has always built it — routing the local
      // driver through this factory must not change where a locally-run Task's jail is.
      return createLocalExecutor(opts.worktreeRoot);
    case "docker":
      return createDockerExecutor(dockerHost(opts), config, opts.ids, dockerOpts(opts));
    /*
     * Configurable but not runnable (#97 SSH, #107 Kubernetes). Unreachable in the lifecycle,
     * which checks `hasDriver` before it ever gets here — but stated rather than left to fall
     * through, and worded by `drivers.ts` so the operator reads the same sentence whichever gate
     * caught it.
     */
    case "ssh":
    case "cloud":
      throw new Error(missingDriverReason(config.kind));
    default: {
      /*
       * Unreachable by the type, and that is the point: a fifth member added to the union
       * without a case above makes this assignment fail to compile. The runtime throw is for the
       * database's sake — `executor_profile.config` is a JSON column with no CHECK constraint,
       * so a row can name a kind this build has never heard of, and the honest answer is a
       * failure with the kind in it rather than a silent local run.
       */
      const exhaustive: never = config;
      throw new Error(missingDriverReason((exhaustive as { kind: never }).kind));
    }
  }
}

/**
 * Is this profile's execution host ready, asked once per run.
 *
 * Separate from `createExecutorFor` because the two have opposite costs and opposite homes.
 * Building the executor is synchronous and free — deliberately, because the Inngest handler body
 * re-runs from the top at every step boundary — while probing talks to a daemon and may spend
 * minutes pulling an image, so it belongs inside one durable `step.run` and the constructor
 * emphatically does not.
 *
 * Both must be handed the **same** `ExecutorFactoryOpts` object rather than two equal ones: the
 * probe fills `probedCommands` and `spawn` reads it synchronously, and two separately-defaulted
 * maps would leave `spawn` consulting one that nothing ever wrote to.
 *
 * A kind with no probe passes instead of being made to invent one. The local driver runs on the
 * host this code is already running on, and there is no question about it a probe could answer
 * that the process has not already answered by existing.
 */
export async function probeExecutorFor(
  profile: { config: ExecutorConfig },
  opts: ExecutorFactoryOpts,
): Promise<PreflightResult> {
  const config = profile.config;
  if (config.kind !== "docker") return { ok: true, harnessCommands: [] };
  return probeExecutor(dockerHost(opts), config, opts.ids, dockerOpts(opts));
}

/**
 * The host `Executor` the container driver composes.
 *
 * `process.cwd()` as its root because the driver never uses the host executor's `fs` or
 * `metrics` — only `exec` and `spawn`, both of which name their own working directory. In idiom
 * with `handleProbePost`, which builds one the same way.
 */
export function dockerHost(opts: Pick<ExecutorFactoryOpts, "host">): Executor {
  return opts.host ?? createLocalExecutor(process.cwd());
}

/**
 * The options both the driver and its preflight need, built once so the deployment settings are
 * read in one place.
 *
 * `SOLOW_DOCKER_BIN`, `SOLOW_DOCKER_USER` and `SOLOW_DOCKER_PULL_TIMEOUT_MS` are resolved here
 * rather than inside `docker.ts`: the driver takes them as parameters so it can be constructed in
 * a test with no environment at all, and `env.ts` stays the one module that reads `process.env`
 * for configuration.
 */
/**
 * The control plane's own directories, which no container may be handed (B5).
 *
 * Directories, not the database file: every launcher keeps the keys beside it — `secret.key` or
 * `dev-secret.key` (which decrypts every stored Secret), `orchestrator.secret`, `stream.secret`,
 * `auth.secret` and the engine's `inngest-*.key` — and a guard that named only the database
 * left a source that holds all of them mountable. And whatever the database driver: a Postgres
 * deployment has no database file, but its keys are still files on this disk. Named by where
 * they are rather than listed by file name, so a key a later launcher adds is covered too.
 *
 * Three places, because three launchers decide it: the database's own directory (the CLI puts
 * it in its data directory, the dev scripts in the checkout's `.solow`), `.solow` under the
 * working directory the launcher scripts run from, and the CLI's data directory (`SOLOW_HOME`,
 * default `~/.solow`) for a deployment whose database is not in it. The worktree and cache
 * roots the CLI keeps inside its data directory stay mountable — `guardMountSource` exempts the
 * deployment's own roots nested in a protected directory.
 */
export function orchestratorStatePaths(
  env: Pick<OrchestratorEnv, "SOLOW_DB_DRIVER" | "SOLOW_SQLITE_PATH" | "SOLOW_HOME">,
  home: string = homedir(),
): string[] {
  const dirs = [
    dirname(resolve(env.SOLOW_SQLITE_PATH)),
    resolve(".solow"),
    resolve(env.SOLOW_HOME ?? join(home, ".solow")),
  ];
  return [...new Set(dirs)];
}

export function dockerOpts(opts: ExecutorFactoryOpts): PreflightOpts {
  const env = orchestratorEnv();
  return {
    jailRoot: opts.jailRoot,
    worktreeRoot: opts.worktreeRoot,
    repoCacheRoot: opts.repoCacheRoot,
    protectedPaths: orchestratorStatePaths(env),
    bindPaths: opts.bindPaths ?? [],
    ...(opts.transcriptStore ? { transcriptStore: opts.transcriptStore } : {}),
    ...(opts.checkpointStore ? { checkpointStore: opts.checkpointStore } : {}),
    dockerBin: env.SOLOW_DOCKER_BIN,
    user: env.SOLOW_DOCKER_USER ?? defaultContainerUser(),
    pullTimeoutMs: env.SOLOW_DOCKER_PULL_TIMEOUT_MS,
    ...(opts.harnessCommands ? { harnessCommands: opts.harnessCommands } : {}),
    ...(opts.probedCommands ? { probedCommands: opts.probedCommands } : {}),
    ...(opts.role ? { role: opts.role } : {}),
  };
}

/** A launch that is not a Task's run, and how to end it — see `openOutOfBandExecutor`. */
export interface OutOfBandExecutor {
  executor: Executor;
  /** The scratch directory: the harness's working directory, and a container's only bind mount. */
  cwd: string;
  /**
   * The run's own preflight against this executor — `ok` without asking anything for a local one.
   * Like the run's, a thrown error is a flake (a pull that timed out) and `ok: false` a verdict;
   * the caller turns both into an answer.
   */
  preflight(): Promise<PreflightResult>;
  /** Removes the container, if one was made, and the scratch directory. Never rejects. */
  dispose(): Promise<void>;
}

export interface OutOfBandOpts {
  workspaceId: string;
  /** The Task an Explain is about: a label on the container, nothing more. Null for a probe. */
  taskId: string | null;
  /** Which route is asking; names the scratch directory so a leftover says what made it. */
  purpose: "explain" | "probe";
  /** What will be spawned, probed by the preflight exactly as a run's harness commands are. */
  harnessCommands: readonly string[];
  /** `SOLOW_WORKTREE_ROOT` and `SOLOW_REPO_CACHE_ROOT`, as a run is handed them (unresolved). */
  worktreeRoot: string;
  repoCacheRoot: string;
  /** See `ExecutorFactoryOpts.host`. */
  host?: Executor;
}

/**
 * Somewhere to launch a harness that is not a Task's run: the Brief tab's Explain, the guided
 * setup's test (roadmap B4).
 *
 * Both used to start the harness on the orchestrator's host whatever the Executor Profile said,
 * so a Workspace whose Tasks ran in a container was explained to — and, worse, *tested* — by a
 * harness on a machine its Tasks never touch: the setup could pass on a host-installed Claude
 * while the image had none, or fail on a host without one while the container was fine. This
 * builds the executor the run would build, through the same `createExecutorFor` and
 * `probeExecutorFor`, so the image, the limits, the prepare script, the utilities and the harness
 * binary are the run's, and so is every refusal.
 *
 * What it does *not* share with the run is the container. A one-shot (`ContainerRole`) is named
 * for this request, mounts only the request's own scratch directory — no worktree, no repository,
 * no transcript store; the profile's own mounts stay, since they are part of the environment the
 * operator configured for every container of it — and is removed by `dispose()`, which the caller
 * puts in a `finally`. A running Task's container is never adopted, disturbed or removed by it.
 *
 * The scratch directory is under `SOLOW_WORKTREE_ROOT` for a container, not the system temp
 * directory: it has to pass the mount guard, and the deployment's own root is the one place that
 * always does — a macOS `$TMPDIR` (`/var/folders/…`) never would. A local launch keeps the temp
 * directory it always had, since nothing is mounted.
 *
 * A null profile is the host: Settings' "Test" asks about a Harness Profile with no executor in
 * view, and keeps the probe it always had.
 */
export async function openOutOfBandExecutor(
  profile: { config: ExecutorConfig } | null,
  opts: OutOfBandOpts,
): Promise<OutOfBandExecutor> {
  const config = profile?.config ?? { kind: "local" as const };
  if (config.kind !== "docker") {
    // Refused before any directory is made, in the factory's own words; the lifecycle's
    // `hasDriver` gate has the same sentence for a run.
    if (config.kind !== "local") throw new Error(missingDriverReason(config.kind));
    const cwd = await mkdtemp(join(tmpdir(), `solow-${opts.purpose}-`));
    return {
      executor: createLocalExecutor(cwd),
      cwd,
      preflight: async () => ({ ok: true, harnessCommands: [] }),
      dispose: () => rm(cwd, { recursive: true, force: true }).catch(() => {}),
    };
  }

  // Made if absent: the setup's test is routinely the first thing to run on a fresh install,
  // before any Task has created the root.
  await mkdir(opts.worktreeRoot, { recursive: true });
  const cwd = await mkdtemp(join(opts.worktreeRoot, `.solow-${opts.purpose}-`));
  const factoryOpts: ExecutorFactoryOpts = {
    // A request id where a run puts its Session's: the one-shot's name and `solow.run` label.
    ids: { workspaceId: opts.workspaceId, taskId: opts.taskId ?? "", sessionId: randomUUID() },
    jailRoot: cwd,
    worktreeRoot: opts.worktreeRoot,
    repoCacheRoot: opts.repoCacheRoot,
    harnessCommands: opts.harnessCommands,
    // One map for both, as `probeExecutorFor` requires.
    probedCommands: new Map(),
    role: "oneshot",
    ...(opts.host ? { host: opts.host } : {}),
  };
  const executor = createExecutorFor({ config }, factoryOpts);
  return {
    executor,
    cwd,
    preflight: () => probeExecutorFor({ config }, factoryOpts),
    async dispose() {
      // The container first: it holds the scratch directory as a bind mount, and a harness still
      // writing into it would race the removal below.
      await executor.dispose();
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    },
  };
}
