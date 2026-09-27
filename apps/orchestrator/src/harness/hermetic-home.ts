import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutorKind } from "@solow/contracts";

/**
 * A blank, app-owned configuration for every harness SoloW launches (Decision 0027, spec F05).
 *
 * The isolation this module provides is **configuration discovery, not the environment**. A
 * harness handed the orchestrator's `process.env` reads the operator's `~/.claude/`,
 * `~/.claude.json`, `$HOME/CLAUDE.md`, their `settings.json`, their user-level MCP servers and
 * their user-level Skills — so a file edited on the machine silently changed what every Task did,
 * and two deployments of the same SoloW ran differently for reasons nothing recorded. Pointing
 * `HOME` (and the `XDG_*` and `CLAUDE_CONFIG_DIR` names that would otherwise still reach past it)
 * at a directory the app made closes that, while `PATH`, `LANG`, `TERM` and the proxy settings —
 * which are what make the harness able to run at all — are untouched.
 *
 * **Repository-level configuration stays.** A `CLAUDE.md` or a `.claude/` committed in the
 * checkout is the *project's* configuration, reached through the working directory rather than
 * through `$HOME`, and a Task is supposed to obey it.
 *
 * Files are written here with `node:fs`, host-side, exactly as `harness/libraries.ts` writes the
 * generated MCP config and plugin next door: the executor-boundary audit holds process spawning
 * and Bun's host APIs to `executor/local.ts`, and `ExecutorFs` is jailed to relative paths that
 * cannot name this directory on the Docker driver anyway.
 */

/**
 * The environment that points a harness's configuration discovery at `home`.
 *
 * Every name in `HARNESS_CONFIG_ENV_VARS`, and only those — the same list the billing guard drops
 * from an Executor Profile's environment, so the two halves of the guarantee cannot drift apart.
 * The `XDG_*` values are each specification's own default relative to `$HOME`, restated rather
 * than left unset: a variable inherited from the orchestrator would otherwise survive `HOME`
 * being replaced and point one harness subsystem back at the operator's account.
 */
export function harnessConfigEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    // Claude Code honours this over `$HOME` (verified against 2.1.280), so `HOME` alone would
    // leave an operator's `CLAUDE_CONFIG_DIR` pointing the run straight back at `~/.claude`.
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
  };
}

/**
 * Whether the app has to hand this driver a home, or the driver already has one of its own.
 *
 * The Docker driver does not need one: its `baseEnv()` is the *image's* environment, and its
 * `HOME` is the container's tmpfs (`CONTAINER_HOME`), which no operator has ever written to and
 * which dies with the container. Imposing a host path there would be worse than doing nothing —
 * the directory does not exist inside the container — and a second tmpfs or bind to make it exist
 * is precisely what Decision 0027 declines to add.
 *
 * Everything else is assumed to need one. `local` does, plainly. The ssh and cloud kinds are
 * configurable ahead of their drivers and `executor/drivers.ts` refuses to run them at all, so
 * the answer here is never reached for them today; when one arrives it has to decide what an
 * app-owned home means on a machine this process cannot write to, and defaulting to "needs one"
 * makes that a visible problem rather than a silent inheritance of a remote operator's config.
 */
export function needsAppOwnedHome(kind: ExecutorKind): boolean {
  return kind !== "docker";
}

export interface HarnessConfigEnvParams {
  /** The Task's Executor Profile kind — which side of `needsAppOwnedHome` this run falls. */
  kind: ExecutorKind;
  /** `harnessHomePath(worktreeRoot, taskId)`: where an app-owned home goes, when one is needed. */
  home: string;
  /** The execution host's own environment (`Executor.baseEnv()`), which answers for a container. */
  baseEnv: Readonly<Record<string, string | undefined>>;
}

/**
 * The `configEnv` a run is launched with — creating the app-owned home first when this driver
 * needs one.
 *
 * For a driver that does not, the *executor* answers: the container's own `HOME` is taken from
 * `baseEnv` and the rest of the names are restated relative to it, so the same six variables are
 * explicit on both drivers instead of one relying on defaults. A container that declares no
 * `HOME` at all gets nothing imposed rather than a path invented for it — there is nowhere
 * truthful to point.
 *
 * Seeded empty on purpose. Everything the app actually wants the harness to load already arrives
 * on the command line — `--mcp-config` and `--plugin-dir` from `harness/libraries.ts`,
 * `--settings` from `harness/checkpoints.ts` — and writing a second copy of it in here would be a
 * second source of truth for the same configuration. `mkdir -p` is idempotent for the same reason
 * the directory is per-Task and not per-round: round two resumes a conversation round one's
 * harness may have cached something for.
 *
 * **Creating the directory is a courtesy; the environment is the guarantee.** So a `mkdir` that
 * fails does not fail the run and this returns no error: the harness makes its own config
 * directory on a machine it has never run on, and the isolation — that it is not the operator's —
 * holds whether or not the path exists yet. The case where the root is genuinely unwritable is
 * not silently lost either, because the Task's worktree lives in that same root and `git worktree
 * add` fails first, loudly, and about the thing the operator can actually fix.
 */
export async function resolveHarnessConfigEnv(
  params: HarnessConfigEnvParams,
): Promise<Record<string, string>> {
  const { kind, home, baseEnv } = params;

  if (!needsAppOwnedHome(kind)) {
    const hostHome = baseEnv["HOME"];
    return hostHome ? harnessConfigEnv(hostHome) : {};
  }

  const env = harnessConfigEnv(home);
  try {
    // The home itself and the config directory the harness will write into. Nothing else: the
    // `XDG_*` directories are created by whichever tool first wants one, exactly as they are in
    // an ordinary account.
    await mkdir(env["CLAUDE_CONFIG_DIR"] as string, { recursive: true });
  } catch {
    // See above: nothing to report and nothing to abort. The variables below are the isolation.
  }
  return env;
}
