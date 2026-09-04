import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type { ExecutorConfig } from "@solow/contracts";
import { parseDiskPercent } from "./local.js";
import type {
  ExecOpts,
  ExecResult,
  Executor,
  ExecutorFs,
  ExecutorMetrics,
  ForwardHandle,
  ProcessHandle,
  SpawnOpts,
} from "./types.js";

/**
 * The Docker executor (issue #96, spec F07): one long-lived container per Task, every command a
 * `docker exec` into it.
 *
 * The driver **composes a host `Executor`** and issues `host.exec(["docker", ...])` rather than
 * reaching the daemon itself. That is what keeps `scripts/audit-executor-boundary.ts`'s claim —
 * "exactly one file touches the host" — literally true with a second driver in the tree: this
 * file makes no `Bun.*` call and is not on the audit's allow-list. It also makes the driver
 * testable against a fake host `Executor` that records argv, with no daemon in CI.
 *
 * Container-per-command is ruled out by the interface it implements. `ProcessHandle` is "a
 * long-lived child process, shaped for interactive stream-JSON protocols": it takes operator
 * input mid-run and has to survive the TERM→KILL ladder in `packages/acp/src/session.ts` while
 * `prepare-repository`, `provision-worktree`, `seed`, `agent-run-N`, `diff`, `commit` and
 * `cleanup` run around it as separate durable steps. A per-command design would need a
 * long-lived container *as well*. `dispose()` is also the interface's only teardown verb, and it
 * maps 1:1 onto one container per Task.
 *
 * **Creation is lazy and the factory is synchronous, and that is not a style choice.** Inngest JS
 * suspends a run by leaving an unfulfilled step's promise permanently pending, so the handler
 * body is re-executed from the top at every step boundary and abandoned mid-flight. Anything
 * expensive in the constructor would therefore run dozens of times per Task. So
 * `createDockerExecutor` does no I/O at all, and the container is built behind one memoized
 * promise — `docker ps --filter label=… || docker run …`, adoption rather than replacement, so a
 * replay re-attaches to the container the previous pass already made. The expensive readiness
 * probing lives in `preflight.ts`, inside one durable step.
 */

/** The `docker` member of the Executor Profile union, narrowed once here. */
export type DockerExecutorConfig = Extract<ExecutorConfig, { kind: "docker" }>;

/** Which Task, in which Workspace, on which run — the container's real identity (see `LABELS`). */
export interface DockerIds {
  workspaceId: string;
  taskId: string;
  sessionId: string;
}

/**
 * What the preflight learned about the commands a Task is going to spawn.
 *
 * A `Map` rather than a set of names that exist, because `spawn` has to tell three states apart
 * and a set can only carry two: *probed and present* (spawn), *probed and absent* (throw, on the
 * same line `probe.ts` and `claude-code-runner.ts` already guard), and *never probed* — an argv
 * the preflight had no way to anticipate, which must fall through rather than be refused. A set
 * of found names would refuse every one of those; a set of missing names would silently accept a
 * command nobody ever checked and call it verified.
 */
export type CommandProbes = Map<string, boolean>;

export interface DockerExecutorOpts {
  /**
   * The Task's primary worktree directory. It is the `fs` jail root and the default working
   * directory, exactly as `root` is for the local driver.
   */
  jailRoot: string;
  /**
   * `SOLOW_WORKTREE_ROOT`, resolved. Two things depend on it and neither is optional: it
   * identifies this deployment to the reaper (`solow.deployment`), and it is the boundary the
   * mount-source guard measures a Repository path against.
   */
  worktreeRoot: string;
  /**
   * `SOLOW_REPO_CACHE_ROOT`, resolved — the second directory the deployment owns, and the second
   * boundary the mount-source guard measures against.
   *
   * Optional only because a driver can be constructed without it in a test; production always
   * passes it (`factory.ts` builds one options object for the driver and its preflight, and
   * `PreflightOpts` requires it). Omitting it does not widen the guard, it narrows it: a cache
   * root the guard was not told about is refused unless some other rule reaches it. It is named
   * rather than inferred from `dirname(worktreeRoot)` — see `isMountable` for what inferring it
   * cost.
   */
  repoCacheRoot?: string;
  /**
   * Host directories bind-mounted into the container at their own path — the Task's worktrees
   * and the repositories they were added onto. See `bindArgs` for why the paths are identical
   * on both sides rather than translated.
   */
  bindPaths?: string[];
  /** `SOLOW_DOCKER_BIN`. Named by the caller so a wrapper script is a deployment setting. */
  dockerBin?: string;
  /** `uid:gid` for everything inside the container. See `runArgs`. */
  user?: string;
  /** Shared with the preflight, which fills it. See `CommandProbes`. */
  probedCommands?: CommandProbes;
}

/**
 * A container that cannot be provided, or has stopped being one.
 *
 * Mirrors `RepositoryUnusableError` and exists for the same reason: the lifecycle has to tell
 * "this execution host is not available" apart from "the command you ran said no". The
 * distinction is load-bearing in `exec` — see `TRANSPORT_FAILURE`.
 */
export class ExecutorUnavailableError extends Error {}

/** True when the cause is the executor itself rather than the command (see the class above). */
export function isExecutorUnavailable(cause: unknown): boolean {
  return cause instanceof ExecutorUnavailableError;
}

/**
 * The utilities every shimmed path in this file depends on.
 *
 * `base64` is on the list because the environment mechanism below is built on it, so a
 * distroless or scratch image fails the preflight legibly instead of producing an agent with an
 * empty environment and no explanation. Distroless images are, deliberately, unsupported.
 */
export const REQUIRED_CONTAINER_UTILITIES = [
  "sh",
  "env",
  "cat",
  "find",
  "mkdir",
  "cp",
  "test",
  "df",
  "base64",
  "git",
] as const;

/**
 * The container's name, derived rather than taken from the Task.
 *
 * `idSchema` is `z.string().min(1)`, so a task id is not guaranteed to match Docker's
 * `[a-zA-Z0-9][a-zA-Z0-9_.-]*` name grammar — and sanitising Owner-reachable text into an
 * identifier is the failure `worktreePath`'s comment already refuses. Deterministic in the
 * deployment, Workspace and Task, so an Inngest replay re-attaches to the container the abandoned
 * pass made instead of leaving it behind and starting a second one.
 *
 * The deployment is in the hash for the same reason it is a label: two orchestrators sharing a
 * daemon can hold the same Workspace and Task ids — `e2e/support/fixture.ts` seeds fixed ones —
 * and observed what that costs, with `docker run` refusing the second one outright ("Conflict.
 * The container name … is already in use"). The label alone does not help, because a name is
 * claimed daemon-wide before any label is read.
 */
export function containerName(
  ids: Pick<DockerIds, "workspaceId" | "taskId">,
  deployment: string,
): string {
  return `solow-${sha256(`${deployment}:${ids.workspaceId}:${ids.taskId}`).slice(0, 12)}`;
}

/**
 * Which orchestrator a container belongs to.
 *
 * Not optional, and the one label neither of this feature's earlier designs had. Two
 * orchestrators sharing a daemon — a dev instance beside a real one, or `e2e/support/fixture.ts`
 * beside a live run — each see the other's containers as belonging to no Task they know about,
 * and a reaper reasoning without this would `docker rm -f` a running agent. Keyed on the
 * worktree root because that is what actually distinguishes two deployments on one machine.
 */
export function deploymentId(worktreeRoot: string): string {
  return sha256(resolve(worktreeRoot)).slice(0, 12);
}

/**
 * Whether `forward()` can reach the container's IP directly.
 *
 * One definition, two callers — the preflight records it for its report and `forward` refuses on
 * it — because a second copy of "is this daemon local" would drift into a `forward` that hands
 * back an unreachable URL for a daemon the preflight had already flagged.
 */
export function dockerDaemonIsLocal(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const host = env["DOCKER_HOST"];
  return host === undefined || host === "" || host.startsWith("unix://");
}

/**
 * The environment a shimmed command is given, as one base64 line.
 *
 * The environment travels on the exec's **own stdin**, ahead of the agent's traffic, and every
 * alternative was rejected for a reason that shows up in production:
 *
 * - `-e KEY=VALUE` puts the value in the docker CLI's argv on the *host*, where `ps` shows it —
 *   precisely what `ExecOpts.env`'s own comment forbids.
 * - `--env-file` and `-e` both *merge over the image's `ENV`*, so neither can express
 *   `SpawnOpts.env`'s replace semantics. Verified: an image declaring `ENV IMAGE_LEAK=iamhere`
 *   leaks it straight through a plain `docker exec`, and only `env -i` clears it.
 * - A file in the container's tmpfs leaves the credential at rest inside the container, and
 *   forces `spawn` to await a write that its synchronous return type cannot absorb.
 *
 * `replace` names the two shapes: `spawn` replaces the environment (so a caller that named no
 * `PATH` gets `unset PATH` first, and the shim's bootstrap `PATH` does not survive into the
 * child), `exec` merges over the container's own.
 */
function envPreamble(env: Record<string, string>, opts: { replace: boolean }): string {
  const lines: string[] = [];
  // First, so it cannot undo a PATH the caller did supply.
  if (opts.replace && env["PATH"] === undefined) lines.push("unset PATH");
  for (const [key, value] of Object.entries(env)) {
    // Rejected rather than skipped: a variable the caller believes it set and the agent never
    // receives is the silent substitution this whole mechanism exists to avoid.
    if (!ENV_NAME.test(key)) throw new Error(`invalid environment variable name: ${key}`);
    lines.push(`export '${key}'='${value.replaceAll("'", "'\\''")}'`);
  }
  // No wrapping: the shim reads exactly one line.
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The shim a spawned agent is launched through, as one argv element.
 *
 * The bootstrap `PATH` exists for exactly one reason — `base64` has to resolve under `env -i` —
 * and the decoded blob's first line then either sets the caller's `PATH` or unsets it, so the
 * child's environment is exactly what `SpawnOpts.env` named. `printf`, `echo`, `shift` and
 * `exec` are builtins and need no `PATH` at all.
 *
 * The shell's own pid ($$) is written to the pid file **before** `exec`, so the recorded pid is
 * the target process itself and not a wrapper that is about to be replaced — that pid is the only thing `kill()`
 * has to signal the process *inside* the container.
 *
 * Verified against busybox `ash` with a 15,740-byte preamble carrying embedded newlines and
 * single quotes: values arrive intact, the image's own `ENV` is cleared, and the agent's
 * remaining stdin arrives unconsumed — `IFS= read -r` does not over-read the pipe. That last
 * property is what the entire mechanism rests on.
 */
export const SPAWN_SHIM = `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
IFS= read -r __b64
eval "$(printf %s "$__b64" | base64 -d)"
echo $$ > "$1"
shift
exec "$@"`;

/**
 * The shim for `exec` with an environment: merge, no `env -i`, no pid file.
 *
 * For `exec`, "the executor's own environment" is the **container's**, never `process.env`.
 * Copying the host's in would leak host credentials into the isolation the profile asked for,
 * which is the opposite of what this driver is for.
 */
export const EXEC_SHIM = `IFS= read -r __b64
eval "$(printf %s "$__b64" | base64 -d)"
exec "$@"`;

/**
 * The daemon saying the container is gone, rather than the command saying no.
 *
 * **Exit 125 is not the signal**, and assuming it was is the bug this pattern exists to prevent.
 * Verified: `docker exec` into a missing container exits **1** (`No such container`) and into a
 * stopped one exits **1** (`container … is not running`). Exit 1 is also what `test -f` returns
 * for "absent" and what `git rev-parse` returns for "not a repository" — so a driver reading the
 * code alone makes a dead container answer "the file is not there", `prepareRepository` then
 * raises `RepositoryUnusableError` (the explicitly non-retryable class), and the Task is
 * permanently failed with an innocent Repository's name on it.
 *
 * Three conditions have to agree before that reading is taken: a narrow exit-code set, **empty
 * stdout**, and the daemon's own message prefix.
 */
const TRANSPORT_FAILURE =
  /^(Error response from daemon: (No such container|container .* is not running|.*Cannot connect to the Docker daemon)|OCI runtime exec failed: .*(no such file or directory: unknown|container not running))/;

const TRANSPORT_EXIT_CODES = new Set([1, 125, 126]);

/**
 * How the `docker` CLI marks its own fatal line, as opposed to everything else it narrates.
 *
 * A structural marker rather than a phrase, which is why `diagnosisLine` can look for it: it is
 * the same eight characters whatever the daemon says after them, and verified on 29.7.2 that it
 * stays literally `docker: ` even when the binary is reached through a `SOLOW_DOCKER_BIN`
 * wrapper under another name — the CLI prints its own name, not its argv[0].
 */
const CLI_ERROR_PREFIX = "docker: ";

/**
 * The first line of a daemon message, which is the part an operator needs.
 *
 * The CLI's own `docker: ` prefix is dropped: it is on every `docker run` failure (verified —
 * "docker: Error response from daemon: invalid mount config …"), it tells someone reading a
 * failed card nothing they cannot see from the Executor Profile, and leaving it in makes the
 * board's reason read like a shell transcript rather than a statement about their Task.
 */
export function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.startsWith(CLI_ERROR_PREFIX) ? line.slice(CLI_ERROR_PREFIX.length) : line;
}

/**
 * The line a `docker` invocation actually diagnosed on, when it narrated something first.
 *
 * `firstLine` is right for a command that fails on its first word and wrong for `docker run`,
 * which writes a progress notice before it. Verified live on 29.7.2, both lines on **stderr**:
 *
 *     Unable to find image 'x:nope' locally
 *     docker: Error response from daemon: pull access denied for … repository does not exist …
 *
 * so an operator whose container could not be built was told the notice and the diagnosis was
 * dropped. `lastLine` is no better — the CLI signs off with "Run 'docker run --help' …". The
 * only stable thing in that transcript is `CLI_ERROR_PREFIX`, which is a marker the CLI emits
 * rather than a sentence, so this survives a daemon that words the failure differently and a
 * host in another locale. Nothing marked means nothing was buried — `docker pull` reports this
 * very failure with no prefix and nothing above it — and the first line is already the answer.
 */
export function diagnosisLine(text: string): string {
  const marked = text
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(CLI_ERROR_PREFIX));
  return firstLine(marked ?? text);
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The environment the `docker` CLI itself is given when it is *spawned* rather than `exec`'d.
 *
 * `Executor.spawn` replaces the child's environment wholesale, so the CLI would otherwise start
 * with nothing and fail to find either the daemon or its own binary. Exactly seven variables,
 * named rather than inherited wholesale: `HOME` is what carries `~/.docker/config.json` and
 * therefore private-registry authentication — `dockerConfig` has no registry-credential field,
 * and that gap is worth stating here rather than papering over.
 */
function dockerCliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * The host areas something may be handed to a container *out of*.
 *
 * An allow-list, because the refusal list this started as was a promise about every path nobody
 * thought of — and it did not hold: verified that with the worktree root anywhere off `/home`,
 * `$HOME` passed it (so `~/.ssh`, `~/.aws` and `~/.docker/config.json` were bind-mounted RW into
 * the agent's container) and so did `/var/run/docker.sock`, which is not a leak but an escape: an
 * agent that can reach the socket starts a privileged container and owns the machine. Naming
 * those two would only move the question to `/etc`, `/root`, `/dev` and the next one.
 *
 * The allow-list's first cut did not hold either, and for the mirror-image reason: the two rules
 * that made it *usable* — one home directory below `/home`, one directory above the worktree root
 * — each admitted a whole area by arithmetic, so `~/.ssh` and `/var/run/docker.sock` were back
 * (reproduced by calling `guardMountSource` directly). Both are fixed below, and neither by
 * naming a path: see `isAccountState` and `isMountable`.
 *
 * These are the places a Unix host keeps site and user *content* rather than itself, and a source
 * has to be strictly **inside** one of them — so a whole area (`/srv`, `/tmp`) is still refused,
 * and so is the ancestor of any of them.
 */
const CONTENT_AREAS = ["/srv", "/opt", "/mnt", "/media", "/data", "/workspace", "/tmp", "/var/tmp"];

/**
 * Where home directories live. Each *home* is an area of its own, one level further down, which
 * is what makes `$HOME/code/app` — where a `local_path` Repository normally is — mountable while
 * `$HOME` itself is not. Only the half of a home an account keeps its work in: see
 * `isAccountState` for the other half, and for why depth alone was not enough.
 */
const HOME_PARENTS = ["/home", "/Users"];

/**
 * Whether the entry directly inside a home directory holds the *account* rather than its work.
 *
 * Depth alone was the first cut's home rule, and depth alone cannot tell `~/code` from `~/.ssh`:
 * both are one level below `$HOME`, so the rule written to make a Repository at `~/code/app`
 * mountable admitted `~/.ssh`, `~/.aws` and `~/.docker` by the same sentence and for the same
 * reason — the exact leak the allow-list above records as already fixed once.
 *
 * A shape, not a list of names, because a list would only move the question to the next dotfile.
 * A Unix account keeps its configuration and its credentials in dot-entries and its work beside
 * them; macOS spells that same distinction `~/Library`, which is why the Finder hides it. So a
 * credential store nobody has invented yet is refused by the sentence that refuses `.ssh`.
 *
 * The deployment's own directories are *not* subject to this — a worktree root at
 * `~/.solow/worktrees` is named by the operator and matched before this is consulted.
 *
 * `Library` is compared case-insensitively and the dot is not, because that is where the two
 * halves of this rule actually differ. `Library` is the macOS spelling, and a macOS volume is
 * case-insensitive by default (APFS and HFS+ both): `~/library/Keychains` and `~/LIBRARY/Keychains`
 * open the same directory as `~/Library/Keychains`, so a case-sensitive comparison refused one
 * spelling of a keychain store and mounted the other two. A leading `.` has no such second
 * spelling — case cannot hide it — so folding there would buy nothing and only widen the rule.
 */
function isAccountState(entry: string): boolean {
  return entry.startsWith(".") || entry.toLowerCase() === "library";
}

/**
 * The characters that let a path re-open the `--mount` value it is spliced into.
 *
 * `runArgs` builds one mount as `type=bind,source=<s>,target=<t>` and the daemon parses that with
 * a **CSV reader**, so a comma in an Owner-supplied path is not data — it starts a new key. A
 * later `src=` (Docker's own alias for `source`) then replaces the source this guard just
 * approved, and the guard's whole claim collapses: it decided about one directory and the daemon
 * mounted another. Reproduced end to end on 29.7.2 through `ensureContainer` itself, not a
 * hand-built argv — a bind path of `/tmp/solow-v2-inj/x,src=/var/run` produced a container whose
 * `.Mounts` read `{"Source":"/var/run","Destination":"/tmp/solow-v2-inj/x","RW":true}`, with the
 * host's Docker socket inside it. The decoy source never has to exist: the injected `src=`
 * replaces it before the daemon looks. `,readonly` and `,bind-propagation=rshared` splice in the
 * same way, and so does `target`, which nothing guarded at all.
 *
 * The double quote is here because the reader is a *CSV* reader and not a `split(",")`: a quote
 * at the start of a field changes how the rest of the value is read. `\n` ends the CSV record,
 * truncating the value rather than extending it — verified on 29.7.2, where the daemon answers
 * `field Target must not be empty` because the record ended before `target` was read. A lone `\r`
 * does not truncate: it mounts a directory with the carriage return in its name. Both are refused
 * anyway, because the guard should not be deciding about a string the daemon reads differently
 * from the way it was written — loud rather than dangerous, but the distance between the two is
 * exactly what this whole guard exists to close.
 *
 * **Refusal rather than quoting, and that is a judgement.** Quoting each field does work —
 * verified on 29.7.2 that `--mount 'type=bind,"source=/tmp/a,b",target=/x'` mounts the literal
 * directory `a,b`, and that a `"` inside doubles as CSV requires. It would be the structurally
 * stronger close, since `runArgs` would then be un-spliceable whatever it was handed. It is not
 * taken because `SOLOW_DOCKER_BIN` points the whole driver at any CLI an operator names, and a
 * quoted field is only understood by a CLI whose `--mount` parser is Go's `encoding/csv`; one
 * that splits on commas would break **every** mount on that host. Refusing buys the same close
 * without depending on a parser this project does not ship, and the only thing it costs is a
 * Repository at a path with a comma in its name, which fails at the preflight with the sentence
 * below rather than silently.
 */
const MOUNT_CSV_CHARS = /[",\r\n]/;

/** Refuse a path that would not survive being spliced into a `--mount` value; see above. */
function refuseCsvInjection(value: string, role: "bind source" | "mount target"): void {
  if (!MOUNT_CSV_CHARS.test(value)) return;
  throw new ExecutorUnavailableError(
    `refusing to mount ${JSON.stringify(value)} into the container: a ${role} may not contain a comma, a double quote or a line break — the daemon reads a \`--mount\` value as CSV, so those characters open a new key inside it and a later \`src=\` would silently replace the source this guard approved`,
  );
}

/**
 * Refuse a bind source that would hand the agent the machine.
 *
 * `resolveRepoPath` returns `params.repository.location` verbatim for a `local_path` Repository —
 * an arbitrary Owner-supplied host path, unvalidated by the schema. Registering `/` or `$HOME` as
 * a Repository must not turn the container the Owner asked for into a view of the whole host, so
 * this decides what the container may be given at all rather than what it may not: the
 * deployment's own directories — the worktree root and the repository cache root, each as the
 * operator set it — plus anything strictly inside a `CONTENT_AREA` or the *work* half of a home
 * directory. Everything else is refused before a `docker run` line is built.
 *
 * "What the container may be given **at all**" is only true because of `MOUNT_CSV_CHARS`, and it
 * was false as written until that was added: the approved string is spliced into a `--mount`
 * value the daemon reads as CSV, so a path with a comma in it used to smuggle a second `src=`
 * past every rule below and mount a directory this function never saw.
 *
 * The roots are taken as an object rather than two positional strings so that adding a third
 * deployment directory cannot silently be read as one of the first two at a call site.
 *
 * **This is not a pure function, and it cannot be, because the daemon is not.** `resolve()` is
 * string arithmetic; Docker resolves the bind source's symlinks on the host before it mounts
 * anything. So a lexical guard decides about one path and the daemon mounts another, and that
 * gap was a live host-root escape: a symlink to `/` placed under `/tmp` — a `CONTENT_AREA`, and
 * world-writable — passed every rule below, and `docker run --mount type=bind,source=<link>`
 * then handed the container `/etc/shadow` and `/var/run/docker.sock` (reproduced on 29.7.2).
 * Reachable from a `local_path` Repository, which is the whole surface this exists to close.
 *
 * So the source has to be checked as the daemon will see it, and **both** spellings must pass —
 * each against an allow-list in *its own* spelling. The lexical path is checked against the
 * lexical rules, because that is what goes into the run line and what the container sees at the
 * same path (`bindsFor`); the realpath is checked against the same rules put through the same
 * resolver, because that is the directory the daemon actually binds.
 *
 * Comparing a *resolved* source against *unresolved* rules is what the first cut of this did,
 * and it refused an entire OS family. Fedora Silverblue, CoreOS and the rest of the rpm-ostree
 * family ship `/home` as a symlink to `/var/home` (`/home -> /export/home` is the same shape on
 * NFS layouts), so `realpath /home/dev/code/app` is `/var/home/dev/code/app` — which no rule
 * reached. On such a host every ordinary `local_path` Repository, the deployment's own worktree
 * root, a Task's worktree and the cache clone were all refused, so no Task could start at all,
 * and the operator was told their own `$HOME` was "a symlink". Resolving both sides is also what
 * finally covers the deployment that symlinks `SOLOW_WORKTREE_ROOT` onto another volume: its
 * canonical root is compared against the canonical source, where before only a landing inside a
 * `CONTENT_AREA` saved it.
 *
 * Refusing every symlink outright would have been simpler to reason about and would have broken
 * that same deployment. Rewriting the source to its realpath was the other option and is ruled
 * out by `bindsFor`: the mount is identical-path by necessity, and a worktree's `.git` file names
 * its gitdir by absolute host path, so mounting it under a different name breaks git inside.
 *
 * The price of consulting the host is that the answer depends on host state at call time — and
 * **it is not the same read the daemon makes**. Three reads happen in a row, not one: this
 * guard's `realpath`, the `mkdir -p` that pre-creates the sources (`ensureContainer`), and the
 * daemon's own resolution inside `docker run`. Anyone who can replace a component of the path
 * between the first and the third gets a mount this guard did not approve, and `/tmp` is a
 * world-writable `CONTENT_AREA`, so on a host with untrusted local users that window is real and
 * nothing here closes it. What it costs is bounded by who can already write inside the area;
 * closing it would need the daemon to accept a mount by file descriptor, which it does not.
 * `resolveLinks` is passed in rather than taken from `node:fs` so that the host is still reached
 * only through the composed `Executor` (`scripts/audit-executor-boundary.ts`).
 *
 * Three more residual risks, stated because they are real. The guard needs a `realpath` that
 * understands `-m`, which busybox's does not have — see `hostResolveLinks` and the preflight rung
 * that asks the host about it once rather than inferring it from the platform. And the host answering here is not necessarily the
 * machine the daemon mounts on: a remote `DOCKER_HOST` resolves these paths here and binds them
 * there, which is outside anything this function can decide.
 *
 * The third is introduced by the canonicalisation above, and is the price of it. Resolving the
 * *rules* is what lets a `/home -> /var/home` host work at all, but it also means any rule that is
 * itself a symlink extends the allow-list to wherever it points — and the rules are SoloW's own
 * constants, not something the operator declared. Verified: with a host where `/data -> /var`,
 * `/data/run/docker.sock` is mountable, because lexically it is strictly inside the area `/data`
 * and canonically `/var/run/docker.sock` is strictly inside the canonicalised area `/var`. Under
 * the previous shape — canonical source measured against unresolved rules — that was refused, and
 * `/home/dev/code/app` on Silverblue was refused with it. There is no honest way to have both:
 * the guard cannot tell "this area moved to another volume", which it deliberately supports, from
 * "this area happens to point at a system tree". A preflight observation could flag a rule that
 * canonicalises onto an ancestor of another rule, which is a product decision rather than
 * something this function should be guessing at.
 *
 * The cost is a deployment that keeps its repositories somewhere this cannot recognise, which
 * fails at the preflight with the sentence below rather than silently mounting; the alternative
 * cost was a container escape reachable from a field the API accepts any string in.
 */
export async function guardMountSource(
  source: string,
  roots: MountRoots,
  resolveLinks: ResolveLinks,
): Promise<string> {
  // First, because everything below reasons about a string that is about to be spliced into a
  // CSV value: a source carrying a comma makes every later answer be about the wrong directory.
  refuseCsvInjection(source, "bind source");
  /*
   * Before the arithmetic, because `resolve()` would otherwise silently supply the missing half
   * from `process.cwd()`: `guardMountSource("relative/path", roots)` used to return the
   * orchestrator's own checkout with `relative/path` on the end, and `guardMountSource("", roots)`
   * the checkout itself — so a Repository whose `location` is `"."` bind-mounted the
   * orchestrator's source, its configuration and any `.env` beside it into the agent's container,
   * read-write, and `executorBindPaths`' `mkdir -p` created whatever was missing. Refusing here
   * also makes every answer below independent of which directory the process was started in.
   */
  if (!isAbsolute(source)) {
    throw new ExecutorUnavailableError(
      `refusing to mount ${JSON.stringify(source)} into the container: a bind source must be an absolute path — a relative one would expose the host directory the orchestrator itself happens to be running in`,
    );
  }
  const path = resolve(source);
  // The source is resolved before the allow-list is, so that a host whose `realpath` cannot
  // answer at all reports the path the operator actually named rather than one of the rules.
  const real = await resolveLinks(path);
  const canonical = await canonicalAllowList(roots, resolveLinks);
  if (!isMountable(path, lexicalAllowList(roots)) || !isMountable(real, canonical)) {
    const via = real === path ? "" : ` (a symlink to ${real})`;
    throw new ExecutorUnavailableError(
      `refusing to mount ${path}${via} into the container: a Repository at this path would expose the host — an agent is given the deployment's own directories, paths inside ${CONTENT_AREAS.join(", ")}, and the work half of a home directory, never the host's own`,
    );
  }
  return path;
}

/**
 * Where a host path really is, once the host's symlinks are followed — the seam `guardMountSource`
 * needs and the reason it is async. See `hostResolveLinks` for the one production implementation.
 */
export type ResolveLinks = (path: string) => Promise<string>;

/**
 * `realpath` on the host, through the composed `Executor` and never `node:fs`.
 *
 * `-m` because the guard runs *before* `ensureContainer` creates the bind sources it was given
 * (`mkdir -p`, further down), so most of these paths do not exist yet: `-m` resolves the
 * symlinks in whatever prefix does exist and normalises the rest, where plain `realpath` and
 * `readlink -f` both fail outright on a path that is not there. `--` because the source is
 * Owner-supplied and may begin with a dash.
 *
 * It fails closed. A host with no `realpath` refuses every mount rather than falling back to the
 * lexical answer, because that fallback *is* the escape this seam exists to close — an operator
 * gets a sentence naming the utility instead of a container quietly holding the host. Both ways
 * a missing binary can arrive are folded into that one sentence: the host executor spawns, and
 * `Bun.spawn` raises ENOENT *synchronously* for a command that does not exist, so `exec` rejects
 * rather than returning 127 (`local.ts`), and an unhandled rejection here would have reported the
 * refusal as an internal error instead.
 *
 * `-m` is also the one thing about this that is not portable, and the guard now asks about many
 * more paths than the sources — the allow-list is resolved through the same seam — so a host
 * without it fails on all of them. busybox's `realpath` has no `-m` (verified on 29.7.2: `realpath: -m:
 * No such file or directory`, exit 1, and it has no `--` either). Whether the BSD `realpath`
 * macOS ships has `-m` was **not** established — no macOS host was reachable to ask — which is
 * exactly why the check below asks the host instead of deciding from a platform name. That makes
 * it a property of the host rather than of a path, so it is asked once by
 * `probeHostResolver` at the preflight; the sentence below names the cause for the mid-run
 * rebuild path, which has no preflight in front of it.
 *
 * Answers are memoised per resolver instance — one instance per `bindsFor` call — because the
 * allow-list is ten-odd fixed paths that would otherwise be re-resolved for every bind source.
 * The cache lives for the length of one argv build, so it does not widen the TOCTOU window
 * `guardMountSource` describes by anything that matters next to the `docker run` that follows.
 */
function hostResolveLinks(host: Executor): ResolveLinks {
  const answered = new Map<string, Promise<string>>();
  return (path) => {
    const asked = answered.get(path) ?? resolveOnHost(host, path);
    answered.set(path, asked);
    return asked;
  };
}

async function resolveOnHost(host: Executor, path: string): Promise<string> {
  const result = await realpathOnHost(host, path);
  const real = firstLine(result.stdout);
  if (result.exitCode !== 0 || real === "") {
    throw new ExecutorUnavailableError(
      `refusing to mount ${path} into the container: \`realpath -m\` on the host could not say where it really points (${failureText(result)}), and a mount guard that cannot follow a symlink would expose the host by guessing — a \`realpath\` without \`-m\` refuses every mount there is (busybox's has none), and the preflight says so in one sentence when that is the cause`,
    );
  }
  return real;
}

/**
 * A path that certainly does not exist, and that `realpath -m` must therefore hand straight back.
 *
 * Nothing is created or read: `-m` is pure string work on a missing path, which is exactly the
 * property being probed — a `realpath` without `-m` cannot answer about a path that is not there,
 * and the guard's sources mostly are not there yet when it asks (`ensureContainer` creates them
 * afterwards).
 */
const RESOLVER_PROBE_PATH = "/.solow-realpath-probe/does-not-exist";

/**
 * Ask the host, once, whether it can answer the mount guard's question at all.
 *
 * Returns the operator-facing reason when it cannot, and `undefined` when it can. A host whose
 * `realpath` lacks `-m` refuses **every** bind source, so without this the Task dies naming one
 * path and an operator goes looking at that path instead of at their userland — and it dies after
 * the image has been pulled, which is minutes spent proving nothing.
 */
export async function probeHostResolver(host: Executor): Promise<string | undefined> {
  const result = await realpathOnHost(host, RESOLVER_PROBE_PATH);
  if (result.exitCode === 0 && firstLine(result.stdout) === RESOLVER_PROBE_PATH) return undefined;
  return `the mount guard cannot run on this host: \`realpath -m -- ${RESOLVER_PROBE_PATH}\` did not answer with that path back (${failureText(result)}) — the guard needs a \`realpath\` that understands \`-m\`, which busybox's does not and a non-GNU one may not, and without it no bind source can be checked against the directory the daemon will really mount, so install GNU coreutils on the host running the orchestrator`;
}

/** The one host command this file's mount guard runs; see `hostResolveLinks` for the `-m`. */
function realpathOnHost(host: Executor, path: string): Promise<ExecResult> {
  return host
    .exec(["realpath", "-m", "--", path])
    .catch((cause: unknown) => ({ stdout: "", stderr: String(cause), exitCode: 127 }));
}

/** The deployment's own directories, as the operator set them. See `DockerExecutorOpts`. */
export type MountRoots = Pick<DockerExecutorOpts, "worktreeRoot" | "repoCacheRoot">;

/**
 * The three rules of the allow-list, in one spelling — lexical or canonical, never mixed.
 *
 * A pair of these is what makes the Silverblue layout work: the same rules are applied twice,
 * once to the path as written against the rules as written, and once to the path as the daemon
 * will resolve it against the rules as the daemon would resolve them. Mixing the two spellings
 * is the defect `guardMountSource` records; keeping them in a value rather than in two code
 * paths is what stops them being mixed again.
 */
interface MountAllowList {
  /** The deployment's own directories, mountable including the roots themselves. */
  roots: string[];
  /** Site and user content areas, mountable strictly *inside* only. */
  areas: string[];
  /** Directories that hold home directories, each home an area of its own one level down. */
  homeParents: string[];
}

function lexicalAllowList(roots: MountRoots): MountAllowList {
  return { roots: deploymentRoots(roots), areas: CONTENT_AREAS, homeParents: HOME_PARENTS };
}

/** Every rule put through the resolver the source went through; see `hostResolveLinks`. */
async function canonicalAllowList(
  roots: MountRoots,
  resolveLinks: ResolveLinks,
): Promise<MountAllowList> {
  const canonicalise = async (paths: readonly string[]): Promise<string[]> => {
    const resolved = await Promise.all(paths.map((path) => resolveLinks(path)));
    // A rule that canonicalises to `/` is not a boundary any more — it is the whole disk — so it
    // drops out rather than making every path below it mountable.
    return resolved.filter((path) => path !== "/");
  };
  const [rootPaths, areas, homeParents] = await Promise.all([
    canonicalise(deploymentRoots(roots)),
    canonicalise(CONTENT_AREAS),
    canonicalise(HOME_PARENTS),
  ]);
  return { roots: rootPaths, areas, homeParents };
}

/**
 * The deployment's own trees, including the roots themselves — production mounts exactly those —
 * and each one **named** rather than inferred from a sibling.
 *
 * `dirname(worktreeRoot)` was how the cache root used to be recognised, and it admitted the whole
 * parent directory rather than the sibling: a deployment rooted at `/var/solow` made every path
 * under `/var/` mountable, `/var/run/docker.sock` among them — reintroducing the escape this
 * allow-list exists to close, by the very rule meant to make it usable. Both roots come from the
 * operator's own environment (`env.ts`) and are already carried in `DockerExecutorOpts`, so
 * asking for the second one costs nothing and guesses nothing.
 *
 * A root of `/` is dropped for the same reason a rule that canonicalises to `/` is: it is not a
 * boundary, it is the disk.
 */
function deploymentRoots(roots: MountRoots): string[] {
  return [roots.worktreeRoot, roots.repoCacheRoot]
    .filter((root): root is string => root !== undefined)
    .map((root) => resolve(root))
    .filter((root) => root !== "/");
}

function isMountable(path: string, allowed: MountAllowList): boolean {
  if (path === "/") return false;
  if (allowed.roots.some((root) => isWithin(path, root))) return true;
  if (allowed.areas.some((area) => path.startsWith(area + sep))) return true;
  /*
   * This path's own home directory, if it is in one, and only for the entries an account keeps
   * its *work* in (`isAccountState`). A home *parent* is not an area: it holds every account on
   * the machine, and one of them is not this deployment's.
   *
   * The segments are counted from the end of the parent rather than from the root, because a
   * canonical home parent is not one segment deep: on the rpm-ostree family `/home` resolves to
   * `/var/home`, and a rule that read `path.split(sep)[1]` saw `var` and refused every home
   * directory on the host.
   */
  for (const parent of allowed.homeParents) {
    if (!path.startsWith(parent + sep)) continue;
    const [account, entry] = path.slice(parent.length + 1).split(sep);
    if (account && entry && !isAccountState(entry)) return true;
  }
  return false;
}

/** `path` is `root` or below it — the same arithmetic `resolveJailed` does, and for the same reason. */
function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep);
}

/** One bind mount, host source to container target. */
interface Bind {
  source: string;
  target: string;
  readOnly: boolean;
}

/**
 * Every mount the container gets, deduplicated and ordered.
 *
 * **Identical-path, and that is forced rather than chosen.** `manager.ts` runs
 * `git -C <repoPath> worktree prune`, `scm-ops.ts` and `status.ts` run `git -C <cwd> …`, and
 * `setup-files.ts` runs `mkdir -p <abs>` and `cp -p <abs> <abs>` — absolute *host* paths in
 * argv, which neither the interface nor the local driver jails or translates, and translating
 * arbitrary argv is undecidable. A worktree's `.git` file also contains `gitdir: <abs host
 * path>`, so a parent repository mounted anywhere else is not a git repository at all from
 * inside.
 */
async function bindsFor(
  host: Executor,
  config: DockerExecutorConfig,
  opts: DockerExecutorOpts,
): Promise<Bind[]> {
  // One resolver for the whole set, so the guard's host calls are the only new I/O here.
  const resolveLinks = hostResolveLinks(host);
  const byTarget = new Map<string, Bind>();
  for (const path of [opts.jailRoot, ...(opts.bindPaths ?? [])]) {
    const source = await guardMountSource(path, opts, resolveLinks);
    byTarget.set(source, { source, target: source, readOnly: false });
  }
  /*
   * The profile's own mounts last: an operator who named a target explicitly meant that target.
   *
   * The target is checked too, and it is the surface nothing checked at all: it is spliced into
   * the same CSV value as the source, so `target: "/data,src=/,dst=/hostfs"` overrode the source
   * the guard had just approved and mounted the host root. There is no allow-list for a target —
   * it is a path *inside* the container, and the profile may name any of them — so the only
   * question asked about it is whether it can reopen the value it travels in.
   */
  for (const mount of config.mounts) {
    const source = await guardMountSource(mount.source, opts, resolveLinks);
    refuseCsvInjection(mount.target, "mount target");
    byTarget.set(mount.target, { source, target: mount.target, readOnly: mount.readOnly });
  }
  return [...byTarget.values()].sort((a, b) => (a.target < b.target ? -1 : 1));
}

/**
 * What a container has to match to be adopted instead of replaced.
 *
 * Everything that cannot be changed after `docker run`, and nothing that can. A profile edited
 * between two review rounds changes this hash, and the stale container is rebuilt rather than
 * silently reused under limits nobody asked for any more.
 */
function configFingerprint(config: DockerExecutorConfig, binds: Bind[], user: string): string {
  const canonical = JSON.stringify({
    image: config.image,
    mounts: binds,
    network: config.network ?? null,
    cpus: config.cpus ?? null,
    memoryMb: config.memoryMb ?? null,
    user,
  });
  return sha256(canonical).slice(0, 16);
}

/**
 * Real identity lives in labels, and **every lookup is by label filter, never by name**.
 *
 * Label values have no charset restriction, so these carry the ids verbatim while the container's
 * name stays a hash. `solow.managed` is the reaper's only enumeration filter, and `solow.cfg`
 * plus `solow.run` together decide adoption — see `ensureContainer`, which will not adopt a
 * container labelled with a *previous* run, because a label cannot be corrected afterwards and
 * the reaper reads this one to spot exactly that.
 */
function labelsFor(
  ids: DockerIds,
  deployment: string,
  fingerprint: string,
): Record<string, string> {
  return {
    "solow.managed": "true",
    "solow.role": "session",
    "solow.schema": "1",
    "solow.deployment": deployment,
    "solow.workspace": ids.workspaceId,
    "solow.task": ids.taskId,
    "solow.run": ids.sessionId,
    "solow.cfg": fingerprint,
  };
}

/**
 * The agent's `HOME` inside the container, when the image does not declare one of its own.
 *
 * A tmpfs (see `runArgs`) rather than the Task's worktree, which is where `baseEnv` used to
 * point it. The worktree is a **host bind mount**, so every credential cache a tool writes to
 * `$HOME` — `.gitconfig`, `.npmrc`, `~/.config/gh/hosts.yml`, an agent CLI's own token store —
 * was landing on the host filesystem and outliving the container that was supposed to contain
 * it. Worse, the worktree is deliberately kept after a hard failure, so those files persisted
 * exactly in the runs nobody goes back and looks at.
 *
 * A tmpfs and not a directory in the image's writable layer because this must be true of *every*
 * image, including one whose `/home` the run user cannot write to: Docker creates the mount point
 * and applies the `uid`/`gid` itself, so there is no image to depend on and no extra `docker exec`
 * to fail. It dies with the container, and it cannot be carried out by a `docker commit`.
 *
 * The cost, stated because it is real: it is RAM, capped, and `exec` — see `runArgs`.
 */
export const CONTAINER_HOME = "/home/solow";

/** The `docker run` argv for a fresh session container. */
function runArgs(
  name: string,
  config: DockerExecutorConfig,
  binds: Bind[],
  labels: Record<string, string>,
  user: string,
): string[] {
  const [uid, gid] = user.split(":");
  const args = ["run", "-d", "--name", name];
  for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
  args.push(
    // A pid 1 that reaps: the kill ladder signals the agent by pid, and a shell that never
    // waits would leave every forked grandchild as a zombie for the life of the Task.
    "--init",
    /*
     * Derived from the orchestrator's own uid, not configured, and not optional. Verified:
     * without it every file the agent writes into the bind-mounted worktree is root-owned on the
     * host, and `cleanupWorktree`'s `git worktree remove --force --force` then fails with
     * permission denied and leaks the worktree silently — *after* the Task is marked done.
     */
    "--user",
    user,
    /*
     * The pid files the spawn shim writes, and nothing else. `uid=`/`gid=` are not decoration:
     * verified that with `mode=0700` alone the tmpfs is owned by root and a `--user 1000:1000`
     * exec cannot write to it at all ("can't create /run/solow/x: Permission denied"). It is
     * `noexec` by default, so nothing can ever be executed out of it.
     */
    "--tmpfs",
    `/run/solow:rw,mode=0700,uid=${uid},gid=${gid},size=1m`,
    /*
     * The agent's `HOME` (`CONTAINER_HOME`), so that what a tool caches there dies with the
     * container instead of being written into the bind-mounted worktree on the host.
     *
     * `exec` is passed explicitly and the pid-file tmpfs above deliberately does not have it:
     * Docker mounts a tmpfs `noexec` by default, and a `HOME` that cannot execute breaks every
     * agent CLI that installs a helper into `~/.local/bin` or `~/.bun/bin`. Verified live that
     * the mount comes up without `noexec` when it is named, and writable by the `--user` uid.
     *
     * 64 MiB, and a figure rather than the daemon's default of half of host RAM: what belongs in
     * `HOME` is configuration and tokens — kilobytes — while a package cache that grows past this
     * is memory charged to the container's `--memory` limit, which would turn a large `npm
     * install` into an OOM kill instead of an ENOSPC an agent can report. Work that needs the
     * space belongs in the worktree, which is disk.
     */
    "--tmpfs",
    `${CONTAINER_HOME}:rw,exec,mode=0700,uid=${uid},gid=${gid},size=64m`,
  );
  for (const bind of binds) {
    /*
     * `--mount`, never `-v`: verified that a missing bind source is refused loudly ("bind source
     * path does not exist"), where `-v` would silently create a root-owned directory and give the
     * agent an empty worktree with no explanation.
     *
     * This join is a splice, and the daemon reads what comes out of it as CSV — a comma in
     * `source` or `target` opens a new key, and a later `src=` replaces the source the guard
     * approved. That was a live host-root escape, reproduced through `ensureContainer` itself.
     * What closes it is `MOUNT_CSV_CHARS`, upstream in the guard, rather than an escaping step
     * here: see there for why quoting the fields — which Docker's own parser does accept — was
     * measured and not chosen.
     */
    const parts = [`type=bind`, `source=${bind.source}`, `target=${bind.target}`];
    if (bind.readOnly) parts.push("readonly");
    args.push("--mount", parts.join(","));
  }
  // No per-Task networks: the daemon's default unless the profile names one. A user-defined
  // network per Task would buy isolation the product does not claim and cost the reaper a second
  // resource class to enumerate and clean up.
  if (config.network) args.push("--network", config.network);
  if (config.cpus !== undefined) args.push("--cpus", String(config.cpus));
  if (config.memoryMb !== undefined) {
    // Swap pinned to the same figure: without `--memory-swap` the daemon grants twice the
    // memory as swap, so a profile asking for a 512 MiB ceiling would quietly get 1 GiB.
    args.push("--memory", `${config.memoryMb}m`, "--memory-swap", `${config.memoryMb}m`);
  }
  args.push(
    "--pids-limit",
    "512",
    "--security-opt",
    "no-new-privileges:true",
    "--entrypoint",
    "/bin/sh",
    config.image,
    "-c",
    "while :; do sleep 3600; done",
  );
  // Deliberately not `--rm`: an auto-removing container leaves the reaper nothing to find after
  // a crash, and an operator no evidence of what happened.
  return args;
}

/**
 * This orchestrator process, as a value a container can carry (issue #96, AC-4).
 *
 * The reaper's other evidence of life — the agent registry, and a Task row sitting in `review` or
 * `parked` — cannot tell a live orchestrator from a crashed one. Inngest suspends a run by
 * leaving a step promise pending, so a Task waiting at the review gate has *no* process holding
 * it and no registry entry either; a container it left behind therefore looked identical to one
 * a live run was coming back to, and leaked for ever. What separates the two is which process
 * last claimed the container, which is what this is. Random rather than a pid or a boot time: a
 * pid is reused within minutes on a busy host, and a clock is the daemon's, not ours.
 */
export const ORCHESTRATOR_EPOCH = randomBytes(8).toString("hex");

/**
 * Where a container records the orchestrator process that has it in hand.
 *
 * A file rather than a label, because labels are fixed at `docker run` and this fact is not: a
 * run resumed after a restart adopts the container it parked on, and the claim has to move with
 * it. It lives on the pid-file tmpfs, so it dies with the container and can never outlive the
 * process it names by surviving into a `docker commit`.
 */
export const CONTAINER_OWNER_PATH = "/run/solow/owner";

/**
 * Record this process as the container's owner — best-effort, and deliberately not fatal.
 *
 * A container nobody managed to claim is one the reaper may take once its Task has also gone
 * quiet, which is a rebuild on the next pass; failing the Task here instead would turn a full
 * tmpfs or an image without `sh` into a dead run rather than a slow one, and the preflight
 * already reports a missing `sh` in words an operator can act on.
 */
async function claimContainer(host: Executor, bin: string, name: string): Promise<void> {
  // The epoch is 16 hex characters — nothing in it can end the `echo` and start a command.
  await host.exec([
    bin,
    "exec",
    name,
    "sh",
    "-c",
    `echo ${ORCHESTRATOR_EPOCH} > ${CONTAINER_OWNER_PATH}`,
  ]);
}

/**
 * Get this Task's container, adopting the one already there when it is still the right one.
 *
 * Adoption is `provisionWorktree`'s "reuse existing work, replace only what is not this Task's"
 * rule applied to containers: an Inngest retry, a second review round or a replay pass must not
 * tear down a live agent's workspace. A container that has stopped, whose `solow.cfg` no longer
 * matches the profile, or that belongs to a previous *run* of this Task, is removed and rebuilt.
 */
export async function ensureContainer(
  host: Executor,
  config: DockerExecutorConfig,
  ids: DockerIds,
  opts: DockerExecutorOpts,
): Promise<{ name: string; created: boolean }> {
  const bin = opts.dockerBin ?? "docker";
  const deployment = deploymentId(opts.worktreeRoot);
  const name = containerName(ids, deployment);
  const user = opts.user ?? defaultContainerUser();
  const binds = await bindsFor(host, config, opts);
  const fingerprint = configFingerprint(config, binds, user);
  const labels = labelsFor(ids, deployment, fingerprint);

  const docker = (args: string[]) => host.exec([bin, ...args]);

  const found = await docker([
    "ps",
    "-aq",
    "--filter",
    "label=solow.managed=true",
    "--filter",
    `label=solow.deployment=${labels["solow.deployment"]}`,
    "--filter",
    `label=solow.workspace=${ids.workspaceId}`,
    "--filter",
    `label=solow.task=${ids.taskId}`,
  ]);
  for (const id of found.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const state = await docker([
      "inspect",
      "-f",
      '{{.State.Running}}|{{index .Config.Labels "solow.cfg"}}|{{index .Config.Labels "solow.run"}}|{{.Name}}',
      id,
    ]);
    const [running, cfg, run, containerPath] = state.stdout.trim().split("|");
    // The name has to match as well as the labels: every exec below addresses the container by
    // its deterministic name (`spawn` is synchronous and cannot await an id), so a container
    // that was renamed out from under us is not adoptable however right its labels look.
    //
    // `solow.run` has to match for a reason that is not about this Task's workspace at all:
    // Docker labels are fixed at `docker run`, so a container adopted across the ordinary
    // stop-then-relaunch path would keep the *dead* run's id for ever — and the reaper reads
    // that label to decide a container was left behind by a previous run. Adopting it left the
    // live run's own container looking orphaned, and the sweep sixty seconds later removed it.
    // Rebuilding is the honest answer either way: a relaunch is a new agent, and what the
    // previous one left running inside the container is not part of its inheritance.
    if (
      running === "true" &&
      cfg === fingerprint &&
      run === ids.sessionId &&
      containerPath === `/${name}`
    ) {
      await claimContainer(host, bin, name);
      return { name, created: false };
    }
    await docker(["rm", "-f", id]);
  }

  // Pre-created on the host, because `--mount type=bind` refuses a source that does not exist —
  // which is the loud failure we want, but only once the directories we *know* about are there.
  for (const bind of binds) await host.exec(["mkdir", "-p", bind.source]);

  const created = await docker(runArgs(name, config, binds, labels, user));
  if (created.exitCode !== 0) {
    /*
     * `diagnosisLine`, not the default `firstLine`: this is the one call site whose command
     * narrates before it fails ("Unable to find image … locally"), and the operator needs the
     * sentence under that. The preflight's `docker pull` rung normally reports a missing image
     * first, so what reaches here is a mid-run rebuild — the case where nobody is watching.
     *
     * The image is named by us rather than left to the daemon, and that is not decoration: the
     * notice this used to report happened to quote the image, while the diagnosis under it names
     * the *repository* without the tag ("pull access denied for solow/agent"). A card has to say
     * which profile failed as well as why, which is the pair `scripts/smoke-docker-executor.sh`
     * asks for in AC-6, and the sibling verdict below already words it this way.
     */
    throw new ExecutorUnavailableError(
      `could not start the executor container for image "${config.image}" — ${failureText(created, diagnosisLine)}`,
    );
  }

  const state = await docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name]);
  const [running, exitCode] = state.stdout.trim().split(" ");
  if (running !== "true") {
    // The image's own words, then removal — a preflight that failed must never leave a container
    // behind for the reaper to explain later.
    const logs = await docker(["logs", "--tail", "20", name]);
    await docker(["rm", "-f", name]);
    const output = firstLine(`${logs.stdout}\n${logs.stderr}`.trim()) || "no output";
    throw new ExecutorUnavailableError(
      `container for image "${config.image}" exited immediately (code ${exitCode ?? "?"}): ${output}`,
    );
  }
  // Claimed on the creation path too, and not only on adoption: `preflight.ts` reaches the
  // daemon through this function before any executor exists, so a container that spends its
  // first minutes inside the preflight's own steps would otherwise be carrying no owner at all.
  await claimContainer(host, bin, name);
  return { name, created: true };
}

/**
 * The profile's `prepareScript`, on stdin and never in argv, and as **root**.
 *
 * `--user 0:0` is passed rather than omitted, and the difference is the whole point: leaving the
 * flag off does not fall back to the image's own user, it inherits the *container's* — which
 * `runArgs` pinned to the orchestrator's uid. Verified live on Docker 29.7.2 that an exec with no
 * `--user` into a `--user 1000:1000` container is uid 1000 and `apk add --no-cache curl` fails
 * with "Unable to open log: Permission denied", so every profile whose prepare script installs a
 * package failed its Task at preflight rung 9. A prepare script that cannot install a package is
 * not a prepare script, so the claim is made true rather than dropped.
 *
 * The cost, stated because it is real: root here can leave root-owned files under the
 * bind-mounted worktree root, which is exactly what `--user` on the run line exists to prevent
 * (`git worktree remove` then fails on the host, after the Task is done). What a prepare script
 * is *for* — installing into the image's own filesystem — lands outside every mount and is
 * unaffected. This is the first consumer of `prepareScript` anywhere in the codebase.
 */
export async function runPrepareScript(
  host: Executor,
  name: string,
  script: string,
  opts: DockerExecutorOpts,
): Promise<ExecResult> {
  const bin = opts.dockerBin ?? "docker";
  return execWithStdin(
    host,
    [bin, "exec", "-i", "--user", "0:0", "-w", opts.jailRoot, name, "sh", "-s"],
    script,
  );
}

/**
 * Which of these commands the image actually has.
 *
 * `command -v a b c` is **not** the probe, however natural it reads: verified against busybox
 * that it reports only its first argument and exits 0, so an image missing `git`, `find` and
 * `base64` passes it cleanly. The loop asks about each one separately and prints the ones that
 * are absent, which is the answer the caller needs to name them.
 */
export async function probeCommands(
  host: Executor,
  name: string,
  commands: readonly string[],
  opts: DockerExecutorOpts,
): Promise<CommandProbes> {
  const bin = opts.dockerBin ?? "docker";
  const probes: CommandProbes = new Map();
  if (commands.length === 0) return probes;
  const result = await host.exec([
    bin,
    "exec",
    name,
    "sh",
    "-c",
    'for c in "$@"; do command -v "$c" >/dev/null 2>&1 || echo "$c"; done',
    "sh",
    ...commands,
  ]);
  const missing = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  for (const command of commands) probes.set(command, !missing.has(command));
  return probes;
}

/**
 * The uid the container runs as, defaulting to the orchestrator's own.
 *
 * Numeric on both halves: a username would be resolved against the *image's* `/etc/passwd`, and
 * the whole reason the flag is passed is that files written into the bind-mounted worktree must
 * land owned by a uid the host can later remove.
 */
export function defaultContainerUser(): string {
  return `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
}

export function createDockerExecutor(
  host: Executor,
  config: DockerExecutorConfig,
  ids: DockerIds,
  opts: DockerExecutorOpts,
): Executor {
  const bin = opts.dockerBin ?? "docker";
  const name = containerName(ids, deploymentId(opts.worktreeRoot));
  const user = opts.user ?? defaultContainerUser();
  const asUser = ["--user", user];
  const jailRoot = resolve(opts.jailRoot);
  const probes = opts.probedCommands ?? new Map<string, boolean>();

  /**
   * The container, built at most once per executor.
   *
   * Memoized rather than created in the factory: see this module's header — the Inngest handler
   * body is re-executed from the top at every step boundary, so a constructor that talked to the
   * daemon would talk to it dozens of times per Task. A *failed* creation clears the memo, so
   * the step retry that follows rebuilds rather than replaying the same rejection.
   */
  let container: Promise<string> | undefined;
  const ready = (): Promise<string> => {
    container ??= ensureContainer(host, config, ids, opts)
      .then(async (result) => {
        if (result.created && config.prepareScript) {
          const prepared = await runPrepareScript(host, result.name, config.prepareScript, opts);
          if (prepared.exitCode !== 0) {
            /*
             * The container goes with the failure, and that is the whole fix: the script runs
             * only on the pass that *created* the container, so leaving a half-prepared one
             * running meant the next pass adopted it with `created: false`, skipped the script
             * and handed the agent a container the profile's `apt-get` had never finished on —
             * verified live, where passes 2 and 3 succeeded against a container whose prepare
             * script had exited 100. Removing it makes the next pass rebuild and fail the same
             * way, loudly, until an operator fixes the script.
             */
            await host.exec([bin, "rm", "-f", result.name]);
            throw new ExecutorUnavailableError(
              `the profile's prepare script failed (exit ${prepared.exitCode}): ${failureText(prepared, lastLine)}`,
            );
          }
        }
        return result.name;
      })
      .catch((cause: unknown) => {
        container = undefined;
        throw cause;
      });
    return container;
  };

  /** Resolve a path within the jail; throws on any attempt to escape it (AC-2). */
  function resolveJailed(relativePath: string): string {
    /*
     * `local.ts`'s check, verbatim, and both halves are load-bearing: resolving before comparing
     * catches `nested/../../escape.txt`, and the trailing separator stops a sibling `/root-evil`
     * passing a bare `startsWith`. It runs **before** any try, so a traversal on `exists`
     * rejects rather than answering false.
     *
     * Enforced here, on the host, before a path reaches the container — the container has no
     * knowledge of `jailRoot` and could not enforce it, and because the mounts are
     * identical-path one check covers both namespaces. This is `node:path` string arithmetic,
     * not a reach around the executor boundary.
     */
    const target = resolve(jailRoot, relativePath);
    if (target !== jailRoot && !target.startsWith(jailRoot + sep)) {
      throw new Error(`path escapes executor root: ${relativePath}`);
    }
    return target;
  }

  /** `docker exec` for a command that needs no environment and no stdin. */
  async function inContainer(cmd: string[], cwd?: string): Promise<ExecResult> {
    const ctr = await ready();
    const result = await host.exec([
      bin,
      "exec",
      ...asUser,
      ...(cwd ? ["-w", cwd] : []),
      ctr,
      ...cmd,
    ]);
    return checkTransport(result);
  }

  const fs: ExecutorFs = {
    async exists(relativePath) {
      const target = resolveJailed(relativePath);
      return (await inContainer(["test", "-e", target])).exitCode === 0;
    },
    async readFile(relativePath) {
      const target = resolveJailed(relativePath);
      // The *container's* view of the file, never a host-side read of the same inode: an image
      // that rewrote the file at start-up, or a mount that is not what the host thinks it is,
      // has to be visible rather than papered over by the identical path.
      const result = await inContainer(["cat", target]);
      if (result.exitCode !== 0) {
        throw new Error(`read failed (${result.exitCode}): ${target}\n${result.stderr}`);
      }
      return result.stdout;
    },
    async writeFile(relativePath, content) {
      const target = resolveJailed(relativePath);
      await inContainer(["mkdir", "-p", dirname(target)]);
      const ctr = await ready();
      /*
       * `-i` is not optional, and its absence is silent. Verified: without it the shim reads EOF
       * immediately, the file is created **zero bytes**, and the exit code is 0 — data loss on
       * the exact path #52 uses to copy `.env` files into a worktree.
       *
       * The path travels as `$1` rather than interpolated into the `sh -c` string, so a filename
       * cannot become shell syntax; the content travels on stdin, so it never appears in argv.
       */
      const result = checkTransport(
        await execWithStdin(
          host,
          [bin, "exec", "-i", ...asUser, ctr, "/bin/sh", "-c", 'cat > "$1"', "sh", target],
          content,
        ),
      );
      if (result.exitCode !== 0) {
        throw new Error(`write failed (${result.exitCode}): ${target}\n${result.stderr}`);
      }
    },
    async list(relativePath = ".") {
      const target = resolveJailed(relativePath);
      /*
       * NUL-delimited, not newline. A filename may legally contain a newline, and splitting on
       * one would inject a fake entry into the #33 file tree — a directory listing is exactly
       * where an attacker-chosen name gets to be data. `-mindepth 1` drops `.`, `-maxdepth 1`
       * keeps it shallow, and dotfiles come through because `find` has no glob to hide them.
       */
      const result = await inContainer([
        "find",
        target,
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-print0",
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`list failed (${result.exitCode}): ${target}\n${result.stderr}`);
      }
      const prefix = target.endsWith(sep) ? target : target + sep;
      return result.stdout
        .split("\0")
        .filter(Boolean)
        .map((entry) => (entry.startsWith(prefix) ? entry.slice(prefix.length) : entry));
    },
    async copy(fromRelativePath, toRelativePath) {
      const from = resolveJailed(fromRelativePath);
      const to = resolveJailed(toRelativePath);
      await inContainer(["mkdir", "-p", dirname(to)]);
      // `-p` preserves the mode: `setup-files.ts` copies private keys, and a copied key that
      // came out world-readable would be a credential leak the copy itself created.
      const result = await inContainer(["cp", "-p", from, to]);
      if (result.exitCode !== 0) {
        throw new Error(`copy failed (${result.exitCode}): ${from} -> ${to}\n${result.stderr}`);
      }
    },
  };

  /** Δusage over Δwall-clock needs a previous sample; the first `metrics()` call has none. */
  let lastCpuSample: { usageUsec: number; at: number } | null = null;
  /** The image's declared environment, resolved once and reused (`baseEnv`). */
  let imageEnv: Promise<Record<string, string>> | undefined;

  return {
    spawn(cmd: string[], spawnOpts: SpawnOpts): ProcessHandle {
      const [argv0] = cmd;
      /*
       * The synchronous-throw gap, closed with what the preflight already learned.
       *
       * `probe.ts` and `claude-code-runner.ts` both wrap `spawn` in try/catch and depend on it
       * throwing when the binary is missing. Docker cannot know that without an async round trip
       * — measured at 270ms for a missing binary, against `probe.ts`'s 400ms race window, which
       * is far too close to rest on. So the preflight asks once, and this reads the answer on the
       * same line those callers already guard. A command the preflight never saw falls through:
       * the failure still arrives legibly as exit 127 plus `executable file not found` on stderr,
       * which `detectFailureSignal` classifies.
       */
      if (argv0 !== undefined && probes.get(argv0) === false) {
        throw new Error(`"${argv0}": not found in the executor image`);
      }

      /*
       * Kicked, not awaited — `ProcessHandle` is returned synchronously and there is nowhere to
       * put an await. In every real run the preflight has already created the container inside
       * its own durable step, so this resolves instantly; if it somehow has not, `docker exec`
       * answers `No such container` on stderr and exits 1, which is legible rather than silent.
       * The rejection is swallowed here and nowhere else: `ready()` clears its own memo on
       * failure, so the next `exec` rebuilds and reports properly, while an unhandled rejection
       * on a promise nobody is awaiting would take the process down instead.
       */
      void ready().catch(() => {});

      const pidFile = `/run/solow/${randomBytes(8).toString("hex")}.pid`;
      const handle = host.spawn(
        [
          bin,
          "exec",
          // `-i` because the environment arrives on this pipe (see `envPreamble`), and never
          // `-t`: a TTY merges stdout and stderr, and both `acp-runner.ts` and
          // `claude-code-runner.ts` depend on the split.
          "-i",
          ...asUser,
          "-w",
          spawnOpts.cwd,
          name,
          // `env -i` is what makes `SpawnOpts.env` mean *replace*: verified that without it the
          // image's own `ENV` merges through and the agent sees variables no caller named.
          "env",
          "-i",
          "/bin/sh",
          "-c",
          SPAWN_SHIM,
          "sh",
          pidFile,
          ...cmd,
        ],
        { cwd: process.cwd(), env: dockerCliEnv() },
      );

      // First thing on the pipe, issued synchronously, so the handle can be returned unwrapped:
      // same `stdin` adapter, the same real streams, the same `exited`. Ordering, flush
      // semantics and the drain race in `cli-passthrough-runner.ts` are inherited rather than
      // reimplemented on top of a wrapper.
      // Rejections are swallowed rather than left floating: a pipe that closed before the
      // preamble landed is already reported by the exit code and stderr the caller is reading,
      // and an unhandled rejection here would take the orchestrator down over it.
      void Promise.resolve(
        handle.stdin.write(`${envPreamble(spawnOpts.env, { replace: true })}\n`),
      ).catch(() => {});
      void handle.stdin.flush().catch(() => {});

      /** The pid *inside* the container, read from the file the shim wrote before `exec`. */
      let pid: Promise<string> | undefined;
      const innerPid = (): Promise<string> => {
        pid ??= (async () => {
          for (let attempt = 0; attempt < 10; attempt++) {
            const read = await host.exec([bin, "exec", ...asUser, name, "cat", pidFile]);
            const value = read.stdout.trim();
            if (read.exitCode === 0 && /^\d+$/.test(value)) return value;
            await new Promise((r) => setTimeout(r, 50));
          }
          throw new Error(`no pid recorded for the container process (${pidFile})`);
        })();
        return pid;
      };

      return {
        stdin: handle.stdin,
        stdout: handle.stdout,
        stderr: handle.stderr,
        exited: handle.exited,
        /*
         * Signal the process *inside* the container, never the `docker exec` client.
         *
         * Verified: terminating the client leaves the inner `sleep 300` running — one leaked
         * agent per stop. Signalling the pid works and the ladder escalates as
         * `packages/acp/src/session.ts` expects: TERM by pid makes the client exit 143, and a
         * process holding `trap "" TERM` survives it and needs KILL, which exits 137. Mapping
         * both rungs onto `docker stop` would instead hang every escalation to its time-box.
         *
         * Fire-and-forget because `kill` is synchronous by the interface, and swallowed because
         * a process that already exited is the ordinary case, not a fault.
         */
        kill: (signal?: number | string) => {
          const sig = signal === "SIGKILL" || signal === 9 || signal === "KILL" ? "KILL" : "TERM";
          void innerPid()
            .then((value) => host.exec([bin, "exec", ...asUser, name, "kill", "-s", sig, value]))
            .catch(() => {});
        },
      };
    },

    async exec(cmd: string[], execOpts: ExecOpts = {}): Promise<ExecResult> {
      // Two paths, because most call sites pass no environment and a shimmed exec costs an
      // extra process and a stdin round trip for nothing.
      if (!execOpts.env) return inContainer(cmd, execOpts.cwd);

      const ctr = await ready();
      const result = await execWithStdin(
        host,
        [
          bin,
          "exec",
          "-i",
          ...asUser,
          ...(execOpts.cwd ? ["-w", execOpts.cwd] : []),
          ctr,
          "/bin/sh",
          "-c",
          EXEC_SHIM,
          "sh",
          ...cmd,
        ],
        `${envPreamble(execOpts.env, { replace: false })}\n`,
      );
      return checkTransport(result);
    },

    async baseEnv(): Promise<Record<string, string>> {
      // The *image's* environment, not the orchestrator's. Handing a containerised agent the
      // host's `PATH` and `HOME` describes a machine it is not running on, and it then fails for
      // reasons that have nothing to do with the Task — see `Executor.baseEnv`.
      imageEnv ??= (async () => {
        const env: Record<string, string> = {};
        const result = await host.exec([
          bin,
          "image",
          "inspect",
          config.image,
          "--format",
          "{{json .Config.Env}}",
        ]);
        if (result.exitCode === 0) {
          try {
            const declared: unknown = JSON.parse(result.stdout.trim() || "null");
            if (Array.isArray(declared)) {
              for (const entry of declared) {
                if (typeof entry !== "string") continue;
                const at = entry.indexOf("=");
                if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
              }
            }
          } catch {
            // A daemon that answered something unparseable is not a reason to fail the run; the
            // defaults below are enough for an agent to start.
          }
        }
        // An image that declares neither still has to produce a runnable environment: `PATH` is
        // the container's own default, and `HOME` is the container's own tmpfs, because an agent
        // whose `HOME` is `/` cannot write its own config and dies on the first tool call.
        //
        // Not `jailRoot`, which is what this was: the jail is a bind mount from the host, so the
        // credentials a tool caches under `$HOME` were being written *onto the host* and kept
        // after the container was gone. See `CONTAINER_HOME`. An image that declares its own
        // `HOME` still wins — it named a directory in its own filesystem on purpose.
        env["PATH"] ??= "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
        env["HOME"] ??= CONTAINER_HOME;
        return env;
      })();
      return imageEnv;
    },

    fs,

    async forward(port: number): Promise<ForwardHandle> {
      if (!dockerDaemonIsLocal()) {
        // Refused rather than answered with a URL nothing can reach: a remote daemon's container
        // IP is on a network this process has no route to, and a preview that silently never
        // loads is worse than one that says why.
        throw new Error(
          `port forwarding needs a local Docker daemon; this executor is using ${process.env["DOCKER_HOST"]}`,
        );
      }
      const target = await ready();
      const ip = (
        await host.exec([
          bin,
          "inspect",
          "-f",
          "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
          target,
        ])
      ).stdout.trim();
      if (!ip) throw new Error("the executor container has no reachable IP address");
      // Honestly a no-op: nothing was allocated. Docker fixes port publishing at container
      // creation and this method is handed a port at call time, so the container's own IP is
      // the only route there is.
      return { url: `http://${ip}:${port}`, close: async () => {} };
    },

    async metrics(): Promise<ExecutorMetrics> {
      /*
       * Read from the container's own cgroup, never proxied from the host.
       *
       * Verified that `/proc/loadavg` inside a container reports the *host's* figures and `nproc`
       * reports the host's 4 CPUs despite `--cpus 0.5` — so copying the local driver's
       * `loadavg()`/`cpus()` proxy would report the orchestrator's load as the Task's, which is a
       * silent correctness bug rather than a rough approximation. `loadAverage` is empty for the
       * same reason: there is no honest container-scoped answer, and the type permits none.
       */
      const empty: ExecutorMetrics = {
        cpuPercent: null,
        memPercent: null,
        diskPercent: null,
        loadAverage: [],
      };
      try {
        const sampledAt = Date.now();
        const probe = await inContainer(["sh", "-c", METRICS_SCRIPT, "sh", jailRoot]);
        const lines = probe.stdout.replace(/\n+$/, "").split("\n");
        // `df -P` prints exactly one header line and one data line, so the disk figure is the
        // tail of the output whether or not the cgroup files above it existed.
        const diskPercent = parseDiskPercent(lines.slice(-2).join("\n"));

        const memCurrent = /^\d+$/.test(lines[0] ?? "") ? Number(lines[0]) : null;
        if (memCurrent === null) {
          // cgroup v1 has no `memory.current`. `docker stats` is correct everywhere but was
          // measured at 1.05s, so it is the fallback and not the default.
          return { ...(await dockerStats(host, bin, await ready())), diskPercent, loadAverage: [] };
        }
        const memMax = /^\d+$/.test(lines[1] ?? "") ? Number(lines[1]) : null;
        const quota = parseCpuMax(lines[2] ?? "");
        const usage = lines.find((line) => line.startsWith("usage_usec"));
        const usageUsec = usage ? Number(usage.split(/\s+/)[1]) : Number.NaN;

        let cpuPercent: number | null = null;
        if (Number.isFinite(usageUsec)) {
          const previous = lastCpuSample;
          lastCpuSample = { usageUsec, at: sampledAt };
          if (previous && sampledAt > previous.at) {
            const elapsedUsec = (sampledAt - previous.at) * 1000;
            // Against the quota the profile asked for, or a single CPU when it asked for none:
            // `nproc` inside the container is the host's count and would make a busy container
            // look idle.
            const share = (usageUsec - previous.usageUsec) / elapsedUsec / (quota ?? 1);
            cpuPercent = Math.max(0, Math.min(100, share * 100));
          }
        }

        return {
          cpuPercent,
          // Null rather than 0 when the ceiling is `max`: an unlimited container has no
          // percentage of anything, and reporting one would be a made-up number.
          memPercent: memMax !== null && memMax > 0 ? (memCurrent / memMax) * 100 : null,
          diskPercent,
          loadAverage: [],
        };
      } catch {
        // `metrics()` never rejects: it decorates a dashboard, and a Task must not fail because
        // its gauge could not be read.
        return empty;
      }
    },

    async dispose(): Promise<void> {
      try {
        // Idempotent — `docker rm -f` on a container that is already gone succeeds — and
        // swallowed either way: teardown must never fail a Task that otherwise completed.
        // Removing the container also destroys the tmpfs and collects any forked grandchildren
        // the kill ladder left behind.
        await host.exec([bin, "rm", "-f", name]);
      } catch {
        // A daemon that has gone away has already disposed of it more thoroughly than we could.
      }
    },
  };
}

/**
 * One exec for every figure, because a dashboard poll that costs four round trips per Task is a
 * poll nobody leaves on. Every path is guarded so a missing file produces no output rather than
 * an error, and the jail root travels as `$1` rather than interpolated into the script.
 */
const METRICS_SCRIPT = `cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max /sys/fs/cgroup/cpu.max 2>/dev/null
grep usage_usec /sys/fs/cgroup/cpu.stat 2>/dev/null
df -Pk "$1"`;

/** `cpu.max` is "<quota> <period>" in microseconds, or "max <period>" for no quota. */
function parseCpuMax(line: string): number | null {
  const [quota, period] = line.trim().split(/\s+/);
  if (!quota || !period || quota === "max") return null;
  const q = Number(quota);
  const p = Number(period);
  return Number.isFinite(q) && Number.isFinite(p) && p > 0 ? q / p : null;
}

/** The cgroup-v1 fallback: correct, and measured at 1.05s, which is why it is not the default. */
async function dockerStats(
  host: Executor,
  bin: string,
  name: string,
): Promise<{ cpuPercent: number | null; memPercent: number | null }> {
  const result = await host.exec([bin, "stats", "--no-stream", "--format", "{{json .}}", name]);
  if (result.exitCode !== 0) return { cpuPercent: null, memPercent: null };
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    const row = parsed as { CPUPerc?: string; MemPerc?: string };
    return { cpuPercent: parsePercent(row.CPUPerc), memPercent: parsePercent(row.MemPerc) };
  } catch {
    return { cpuPercent: null, memPercent: null };
  }
}

function parsePercent(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace("%", ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : null;
}

/** Last line of what a script said, which is where a shell reports what actually went wrong. */
export function lastLine(text: string): string {
  const lines = text.trim().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

/**
 * What a failed command actually said, wherever it said it (AC-6).
 *
 * stderr first, because a diagnosis is normally there — but never stderr alone, which is what
 * left an operator reading `Docker is not reachable — ` with nothing after the dash: verified
 * that a `SOLOW_DOCKER_BIN` pointing at `/bin/false` fails with both streams empty, and that a
 * prepare script reporting its own failure with `echo` writes to stdout. One helper rather than a
 * fallback re-decided at each of the four call sites, because a reason that goes missing is
 * missing on the failed card, where nobody can go and look for it.
 */
export function failureText(
  result: Pick<ExecResult, "stdout" | "stderr">,
  pick: (text: string) => string = firstLine,
): string {
  return pick(result.stderr) || pick(result.stdout) || "no output";
}

/**
 * `host.exec` cannot carry stdin, so anything that needs it is spawned and drained here.
 *
 * stdout and stderr are drained **concurrently** with `exited`, exactly as `local.ts` does: a
 * sequential read deadlocks the moment the other pipe fills, and `git ls-files -z` — which
 * `setup-files.ts` reads — is easily large enough to do it.
 */
async function execWithStdin(host: Executor, cmd: string[], stdin: string): Promise<ExecResult> {
  const handle = host.spawn(cmd, { cwd: process.cwd(), env: dockerCliEnv() });
  const written = (async () => {
    await handle.stdin.write(stdin);
    await handle.stdin.flush();
    await handle.stdin.end();
  })();
  const [stdout, stderr, exitCode] = await Promise.all([
    drain(handle.stdout),
    drain(handle.stderr),
    handle.exited,
  ]);
  await written.catch(() => {});
  return { stdout, stderr, exitCode };
}

/**
 * Read a stream with `for await` rather than `new Response(stream)`.
 *
 * `ProcessHandle` promises an `AsyncIterable<Uint8Array>`, not a `ReadableStream` — a host
 * executor is free to hand back a plain async generator, and `new Response` would reject it.
 */
async function drain(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/**
 * Turn "the container is gone" into a thrown `ExecutorUnavailableError` rather than a result.
 *
 * `ExecResult` has no third state, and a silently `false` answer is the corrupting one — see
 * `TRANSPORT_FAILURE`. `manager.ts`'s `run()` helper turns the throw into a step failure, Inngest
 * retries, and the memoized creation rebuilds the container under the same deterministic name.
 */
function checkTransport(result: ExecResult): ExecResult {
  if (
    TRANSPORT_EXIT_CODES.has(result.exitCode) &&
    result.stdout === "" &&
    TRANSPORT_FAILURE.test(result.stderr.trimStart())
  ) {
    throw new ExecutorUnavailableError(
      `the executor container is no longer running: ${firstLine(result.stderr)}`,
    );
  }
  return result;
}
