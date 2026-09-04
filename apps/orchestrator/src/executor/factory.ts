import type { ExecutorConfig } from "@solow/contracts";
import { orchestratorEnv } from "../env.js";
import {
  type CommandProbes,
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
 * configuration into somewhere an agent can actually run.
 *
 * Shaped exactly like `createAgentRunner`'s protocol switch, and for the same reason: an
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
  /** What this Task will `spawn`, so the preflight can prove it exists before the agent starts. */
  agentCommands?: readonly string[];
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
  if (config.kind !== "docker") return { ok: true, agentCommands: [] };
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
export function dockerOpts(opts: ExecutorFactoryOpts): PreflightOpts {
  const env = orchestratorEnv();
  return {
    jailRoot: opts.jailRoot,
    worktreeRoot: opts.worktreeRoot,
    repoCacheRoot: opts.repoCacheRoot,
    bindPaths: opts.bindPaths ?? [],
    dockerBin: env.SOLOW_DOCKER_BIN,
    user: env.SOLOW_DOCKER_USER ?? defaultContainerUser(),
    pullTimeoutMs: env.SOLOW_DOCKER_PULL_TIMEOUT_MS,
    ...(opts.agentCommands ? { agentCommands: opts.agentCommands } : {}),
    ...(opts.probedCommands ? { probedCommands: opts.probedCommands } : {}),
  };
}
