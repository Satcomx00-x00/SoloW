import { join } from "node:path";
import type { RepositorySource } from "@solow/contracts";
import { taskCheckoutBranch } from "@solow/core";
import type { Executor } from "../executor/types.js";
import { setupFileExclusions } from "./setup-files.js";

/**
 * Git worktree manager (spec F08 / task TASK-015). Each Task gets an isolated worktree so
 * concurrent Tasks never share working files (Principle II). Repositories come from a local
 * clone path or a remote URL that is cloned into a cache first (clarified 2026-08-17).
 *
 * Every git invocation goes through the `Executor` (issue #1) rather than a `Bun.spawn`/shell
 * call of its own — that is what makes a second executor kind (#46 #47 #48) a driver instead of
 * a second implementation of "where does this worktree actually live".
 */

/** Run a command through the executor; throws with stderr on a non-zero exit. */
async function run(
  executor: Executor,
  cmd: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await executor.exec(cmd, env ? { env } : {});
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${result.exitCode}): ${cmd.join(" ")}\n${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Deterministic, collision-free branch name for a Task's worktree.
 *
 * Delegated to `@solow/core` rather than spelled out here: the DAL derives the same name
 * when an attachment omits a branch, and the migration that backfilled existing Tasks wrote it.
 * Three places, one template — a second copy is a silent divergence waiting to happen.
 */
export function worktreeBranch(taskId: string): string {
  return taskCheckoutBranch(taskId);
}

/**
 * Deterministic worktree directory for one of a Task's Repository attachments (issue #7).
 *
 * The primary attachment keeps the Task's own directory, so nothing about a single-Repository
 * Task moves; every other attachment gets a sibling named for the attachment, not for the
 * repository. Keyed on the attachment id for two reasons: a future second branch of the *same*
 * repository (parity row 13) already has its own directory, and the path never contains
 * Owner-authored text — a Repository called `../../etc` cannot climb out of the worktree root,
 * and two repositories both called "api" cannot collide.
 */
export function worktreePath(root: string, taskId: string, attachmentId?: string): string {
  return attachmentId ? join(root, `${taskId}--${attachmentId}`) : join(root, taskId);
}

/**
 * Where a Task's **own** copy of a Repository lives, when it is given one (`ownClone`).
 *
 * Under the cache root rather than the worktree root, because it is a repository and not a
 * worktree, and keyed exactly like `worktreePath` — one directory per *attachment*, so the two
 * halves of one attachment (its repository and its worktree) are named by the same rule and a
 * Task attaching one Repository twice gets two of each. As with `worktreePath`, no
 * Owner-authored text reaches the path: a Repository called `../../etc` cannot climb out.
 *
 * `tasks/` keeps them out of the way of the URL-named shared clones beside them
 * (`encodeURIComponent(location)`), which always contain a `%` or a `:` and so can never
 * collide with this segment.
 */
export function taskRepositoryPath(
  repoCacheRoot: string,
  taskId: string,
  attachmentId?: string,
): string {
  return join(repoCacheRoot, "tasks", attachmentId ? `${taskId}--${attachmentId}` : taskId);
}

export interface ProvisionParams {
  taskId: string;
  repository: { source: RepositorySource; location: string };
  baseRef?: string | undefined;
  /**
   * The branch this worktree is checked out on. Defaults to `worktreeBranch(taskId)`, which is
   * what an attachment that named no branch was given at write time anyway.
   */
  checkoutBranch?: string | undefined;
  /**
   * The secondary attachment this worktree belongs to; omitted for the primary, which keeps the
   * Task's own directory. See `worktreePath`.
   */
  attachmentId?: string | undefined;
  worktreeRoot: string;
  repoCacheRoot: string;
  /**
   * Give this Task a repository of its own instead of adding a worktree to the shared one
   * (issue #96 round 2, Principle II).
   *
   * Set when the Task runs somewhere the shared repository must not be reachable from — today
   * that means a container, whose mounts are the whole of what the agent can touch. Every git
   * command below then acts on `taskRepositoryPath` rather than on the clone two Tasks on one
   * Repository would otherwise share, which is what makes the container's mount set contain
   * nothing but this Task's own directories.
   *
   * Off by default, and off for a local run: two local Tasks share a uid, a filesystem and a
   * process table, so a private clone there would cost a copy of the repository to buy an
   * isolation the host does not provide anyway (F07, *the isolation that holds*).
   */
  ownClone?: boolean | undefined;
  /**
   * The credential for cloning an imported repository (issue #15). Present only for a Repository
   * that came from an Integration; a public URL or a local path needs none. The token is read
   * from the Integration's Secret at run time and lives only for the length of the clone.
   */
  cloneCredential?: CloneCredential | undefined;
}

/**
 * A username/token pair for an https clone. The username is the provider's convention
 * (`x-access-token` for GitHub, `oauth2` for GitLab) — both providers authenticate on the token
 * and ignore the username, but sending the expected one avoids relying on that.
 */
export interface CloneCredential {
  username: string;
  token: string;
}

/** Environment variable the credential helper below reads the token from. */
const TOKEN_VAR = "SOLOW_SCM_TOKEN";

/**
 * `git clone` arguments that authenticate without ever writing the token somewhere it persists.
 *
 * The token goes in the environment and is read back by an inline credential helper. The three
 * obvious alternatives all leak it: putting it in the URL stores it in `.git/config` and prints
 * it from `git remote -v` forever; `http.extraHeader` puts it in argv, where any user on the box
 * can read it out of `ps`; a `.git-credentials` file leaves it on disk after the clone.
 *
 * The empty `credential.helper=` first clears any helper the host has configured, so a stale
 * cached credential cannot take precedence over the one for this Integration. `GIT_TERMINAL_PROMPT=0`
 * turns an auth failure into a failure — without it git blocks on a username prompt that no one
 * is there to answer, and the Task hangs instead of reporting the problem.
 */
function credentialArgs(credential: CloneCredential): {
  args: string[];
  env: Record<string, string>;
} {
  const helper = `!f() { echo username=${credential.username}; echo "password=$${TOKEN_VAR}"; }; f`;
  return {
    args: ["-c", "credential.helper=", "-c", `credential.helper=${helper}`],
    env: { [TOKEN_VAR]: credential.token, GIT_TERMINAL_PROMPT: "0" },
  };
}

export interface Worktree {
  path: string;
  branch: string;
  /** The main repository the worktree was added onto (needed for cleanup). */
  repoPath: string;
}

/** The Repository as the deployment holds it (local path, or a cached clone). */
async function upstreamRepoPath(executor: Executor, params: ProvisionParams): Promise<string> {
  if (params.repository.source === "local_path") return params.repository.location;
  // remote_url: clone into the cache once (idempotent), then add worktrees from it.
  const cachePath = join(params.repoCacheRoot, encodeURIComponent(params.repository.location));
  const marker = await executor.exec(["test", "-f", join(cachePath, ".git", "HEAD")]);
  if (marker.exitCode !== 0) {
    const auth = params.cloneCredential ? credentialArgs(params.cloneCredential) : null;
    await run(
      executor,
      ["git", ...(auth?.args ?? []), "clone", params.repository.location, cachePath],
      auth?.env,
    );
  }
  return cachePath;
}

/**
 * The Task's own copy of the repository, made once and reused (`ownClone`).
 *
 * **`init` + `fetch`, not `clone`**, and both departures are load-bearing:
 *
 *  - `git clone` refuses a destination that is not empty, and this destination is not always
 *    empty: it is a directory the container driver `mkdir -p`s as a bind source before the
 *    container exists, and an attempt killed part-way through leaves it half-populated. `clone`
 *    would then fail on every retry for the life of the Task, and the obvious repair — remove
 *    the directory and clone again — is the one thing that must not happen here, because the
 *    running container holds a bind mount of that inode and would keep looking at the deleted
 *    one. `init` and `fetch` are both idempotent *in place*, so a retry finishes the job.
 *  - `clone` from a local path **hardlinks** the object files by default, so the Task's objects
 *    and the shared repository's would be the same inodes — and the container owns them (it runs
 *    as the orchestrator's uid), so an agent could `chmod +w` and rewrite the shared
 *    repository's history through a file inside its own private clone. Verified: a hardlinked
 *    object rewritten from inside a container changed the source repository's copy. A fetch
 *    transfers a pack, so no inode is ever shared.
 *
 * The refspec copies every upstream head to a **local** head rather than a remote-tracking one,
 * because an attachment's `baseRef` has to mean here what it meant in the shared repository. With
 * remote-tracking refs only, `git worktree add -B solow/task-<id> <path> feature-1` does not fail
 * — it silently DWIMs `feature-1` into a new local branch tracking `origin/feature-1` and drops
 * the `-B` entirely, so the Task commits onto the *Owner's* branch instead of its own. Verified
 * on git 2.47. Tags come too, because a base ref may be one.
 *
 * HEAD is pointed outside `refs/heads/` for the duration: git refuses to fetch into the branch
 * HEAD names even when that branch does not exist yet, which is every fresh `init`. The checkout
 * below puts it back on a real branch, and `refs/solow/…` is a namespace no fetched head can
 * occupy.
 *
 * `HEAD` resolving to a commit is the completion marker: it is true only once the fetch *and*
 * the checkout have finished, so an interrupted attempt is redone rather than adopted half-made.
 * No `origin` remote is configured — the shared repository is not reachable from where this runs
 * (that is the point), and a remote pointing at a path the container has no mount for would turn
 * an agent's `git fetch` into a confusing error instead of an honest one.
 */
async function ensureTaskClone(
  executor: Executor,
  params: ProvisionParams,
  upstream: string,
): Promise<string> {
  const own = taskRepositoryPath(params.repoCacheRoot, params.taskId, params.attachmentId);
  const ready = await executor.exec(["git", "-C", own, "rev-parse", "--verify", "-q", "HEAD"]);
  if (ready.exitCode === 0) return own;

  await run(executor, ["git", "init", "-q", own]);
  await run(executor, ["git", "-C", own, "symbolic-ref", "HEAD", "refs/solow/unborn"]);
  await run(executor, [
    "git",
    "-C",
    own,
    "fetch",
    upstream,
    "+refs/heads/*:refs/heads/*",
    "+refs/tags/*:refs/tags/*",
  ]);
  // Check out what the shared repository has checked out, so an agent whose protocol starts it
  // *in the repository* (`claude --worktree`) finds the working tree it expects. Best-effort in
  // both directions: a repository with no commits yet, or one left on a detached HEAD, has
  // nothing to name here, and it is `worktree add` below that owes the caller the error.
  const head = await executor.exec([
    "git",
    "-C",
    upstream,
    "symbolic-ref",
    "--short",
    "-q",
    "HEAD",
  ]);
  const branch = head.stdout.trim();
  if (branch) {
    const exists = await executor.exec([
      "git",
      "-C",
      own,
      "rev-parse",
      "--verify",
      "-q",
      `refs/heads/${branch}`,
    ]);
    if (exists.exitCode === 0) await run(executor, ["git", "-C", own, "checkout", "-f", branch]);
  }
  return own;
}

/** The Repository, and the repository this Task's worktree is actually added onto. */
interface ResolvedRepository {
  /** The shared one, where a result branch has to land to be of any use to the Owner. */
  upstream: string;
  /** The Task's own clone when it has one, and the shared one when it does not. */
  repoPath: string;
}

async function resolveRepoPath(
  executor: Executor,
  params: ProvisionParams,
): Promise<ResolvedRepository> {
  const upstream = await upstreamRepoPath(executor, params);
  if (!params.ownClone) return { upstream, repoPath: upstream };
  return { upstream, repoPath: await ensureTaskClone(executor, params, upstream) };
}

/**
 * The Task's worktree, created if it is not already there (issue #58).
 *
 * Idempotent, because the branch name and the directory are both pure functions of the Task id
 * and nothing ever deletes the branch: `cleanupWorktree` removes the directory and leaves
 * `solow/task-<id>` behind. A second launch of the same Task — a relaunch after a review
 * rejection, a `task.retry` after a failure, or an Inngest step retry inside one run
 * (Principle III) — would otherwise meet `fatal: a branch named '…' already exists` and fail
 * before the lifecycle could report anything.
 *
 * Existing work is reused rather than thrown away. If git already has this exact worktree on
 * this exact branch, that is the Task's workspace and it is returned as-is; the retry then
 * carries on from where the failed attempt stopped, the same way a review round does. Only when
 * the directory is registered against some *other* branch is it replaced, because then it is not
 * this Task's workspace at all. `-B` rather than `-b` covers the remaining case — the branch
 * survived a cleanup and the directory did not — by pointing it back at the base ref.
 */
export async function provisionWorktree(
  executor: Executor,
  params: ProvisionParams,
): Promise<Worktree> {
  const { repoPath } = await resolveRepoPath(executor, params);
  const branch = params.checkoutBranch ?? worktreeBranch(params.taskId);
  const path = worktreePath(params.worktreeRoot, params.taskId, params.attachmentId);
  const base = params.baseRef ?? "HEAD";

  // Best-effort: clears git's record of a worktree whose directory was deleted from underneath
  // it, which would otherwise make `worktree add` refuse the path it no longer occupies.
  await executor.exec(["git", "-C", repoPath, "worktree", "prune"]);

  const existing = (await listWorktrees(executor, repoPath)).find((w) => samePath(w.path, path));
  if (existing) {
    if (existing.branch === branch) return { path, branch, repoPath };
    await run(executor, ["git", "-C", repoPath, "worktree", "remove", "--force", path]);
  }

  // `--force` so a branch still checked out in a worktree that has since moved does not block
  // the Task from getting its own; `-B` so a branch left behind by a cleanup is reset to the
  // base ref rather than colliding with itself.
  await run(executor, [
    "git",
    "-C",
    repoPath,
    "worktree",
    "add",
    "--force",
    "-B",
    branch,
    path,
    base,
  ]);
  return { path, branch, repoPath };
}

/**
 * A Repository that will still be unusable on the next attempt.
 *
 * The distinction is what lets the lifecycle keep both halves of issue #7 AC-3 and Principle III:
 * a location that is not a git repository is answered now, by failing the Task with the
 * Repository's name, while a clone that timed out or a path that was momentarily unavailable
 * throws a plain `Error` and is retried — failing a Task on the first flake is a durability
 * regression, and failing it silently after the retries is the unreadable state AC-3 exists to
 * remove. Only conditions a retry cannot change are raised as this type.
 */
export class RepositoryUnusableError extends Error {}

/** True when the cause is one no retry will fix (see `RepositoryUnusableError`). */
export function isRepositoryUnusable(cause: unknown): boolean {
  return cause instanceof RepositoryUnusableError;
}

/**
 * Make the repository ready for an agent to run in, without creating the Task's worktree.
 *
 * Claude Code creates that itself (`--worktree`), which is what lets several Tasks share one
 * repository at a time. SoloW still has to resolve *which* repository — a local path is
 * used as-is, a remote URL is cloned into the cache once — and to fail here, before any agent
 * starts, when the repository is unusable (TASK-015: an invalid location fails the Task rather
 * than producing a confusing agent error later).
 */
export async function prepareRepository(
  executor: Executor,
  params: ProvisionParams,
): Promise<string> {
  // The *shared* repository is what "is this location usable at all" is a question about, and it
  // is asked before this Task's own clone is made rather than after: a location that is not a
  // repository would otherwise be reported as a fetch that failed — a retryable-looking error
  // for a condition no retry can change (AC-3).
  const upstream = await upstreamRepoPath(executor, params);
  const isRepo = await executor.exec(["git", "-C", upstream, "rev-parse", "--git-dir"]);
  if (isRepo.exitCode !== 0) {
    throw new RepositoryUnusableError(`not a git repository: ${params.repository.location}`);
  }
  return params.ownClone ? await ensureTaskClone(executor, params, upstream) : upstream;
}

/** A worktree as git reports it. */
export interface WorktreeRecord {
  path: string;
  branch: string | null;
}

/**
 * Every worktree attached to a repository, as git sees them.
 *
 * Read from git rather than from a naming convention: the agent creates the worktree, and where
 * it puts it and what it calls the branch are its business. Asking git means the adoption works
 * whatever the CLI decides to do.
 */
export async function listWorktrees(
  executor: Executor,
  repoPath: string,
): Promise<WorktreeRecord[]> {
  const out = await run(executor, ["git", "-C", repoPath, "worktree", "list", "--porcelain"]);
  const records: WorktreeRecord[] = [];
  let current: { path?: string; branch?: string } = {};

  for (const line of `${out}\n`.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line.trim() === "" && current.path) {
      records.push({ path: current.path, branch: current.branch ?? null });
      current = {};
    }
  }
  return records;
}

/**
 * The worktree the agent created, confirmed against git.
 *
 * The agent reports where it is working; this checks that git agrees the path really is a
 * worktree of this repository, and returns its branch. An agent that reported a path outside
 * the repository — or none at all — has not given the Task an isolated workspace, and the
 * caller must fail rather than commit from wherever it happens to be pointing (Principle II).
 */
export async function adoptWorktree(
  executor: Executor,
  repoPath: string,
  reportedPath: string | null,
): Promise<Worktree> {
  if (!reportedPath) {
    throw new Error("agent did not report a workspace; cannot confirm an isolated worktree");
  }
  const known = await listWorktrees(executor, repoPath);
  const match = known.find((w) => samePath(w.path, reportedPath));
  if (!match) {
    throw new Error(
      `agent reported ${reportedPath}, which is not a worktree of ${repoPath}; refusing to use it`,
    );
  }
  return { path: match.path, branch: match.branch ?? "", repoPath };
}

/** Compare paths without tripping over a trailing slash or a `/private` symlink prefix. */
function samePath(a: string, b: string): boolean {
  const normalise = (p: string) => p.replace(/\/+$/, "").replace(/^\/private\//, "/");
  return normalise(a) === normalise(b);
}

/**
 * True when the worktree has uncommitted changes (i.e. the agent produced a diff).
 *
 * `setupFilePatterns` are subtracted for the same reason they are subtracted from the diff: a
 * copied `.env` is not work the agent did, and counting it would send a Task that changed
 * nothing to review with an empty patch (issue #52 AC-4).
 */
export async function hasChanges(
  executor: Executor,
  path: string,
  setupFilePatterns: string[] = [],
): Promise<boolean> {
  const out = await run(executor, [
    "git",
    "-C",
    path,
    "status",
    "--porcelain",
    "--",
    ".",
    ...setupFileExclusions(setupFilePatterns),
  ]);
  return out.trim().length > 0;
}

/**
 * Commit the agent's changes onto the Task's new local branch (no push/PR — spec FR-009).
 *
 * `setupFilePatterns` are excluded from the `add` — the one place in the lifecycle where the
 * exclusion is about more than presentation. A copied `.env` is usually git-ignored and would
 * not be staged anyway, but a pattern naming a *tracked* file would otherwise commit the
 * operator's local copy of it onto the branch, and from there into a pull request (issue #52,
 * Principle IV).
 */
export async function commitWorktree(
  executor: Executor,
  path: string,
  message: string,
  setupFilePatterns: string[] = [],
): Promise<void> {
  await run(executor, [
    "git",
    "-C",
    path,
    "add",
    "-A",
    "--",
    ".",
    ...setupFileExclusions(setupFilePatterns),
  ]);
  await run(executor, ["git", "-C", path, "commit", "-m", message]);
}

/**
 * Put the Task's finished branch into the Repository the Owner actually has (`ownClone`).
 *
 * A Task given its own clone commits into that clone, and a branch nobody can reach is not a
 * result: F08's promise is one branch per Repository per Task, in the Repository, for a reviewer
 * to fetch and merge. So the last act of an approved Task is to move exactly one ref from its
 * private repository into the shared one — and this is the **only** write to the shared
 * repository in the whole lifecycle.
 *
 * It runs where the orchestrator runs, never in the Task's execution host, and that is the shape
 * of the guarantee rather than an implementation detail: the shared repository is not mounted
 * into the container at all, so the agent has no path to it, and what reaches it is one refspec
 * this code wrote naming this Task's own branch. A container that could write to the shared
 * repository is precisely how a peer Task's result branch got rewritten (G4).
 *
 * `fetch` rather than `push`: it needs nothing to be configured in either repository, and it
 * asks the *destination* to do the work, so no hook of the source's can run. Forced, because a
 * second review round may rewrite the branch it published in the first — the safety here is the
 * refspec's single, derived name, not git's non-fast-forward check.
 *
 * A no-op when the Task worked directly in the shared repository (a local run), where the branch
 * is already exactly where it needs to be.
 */
export async function publishWorktreeBranch(
  executor: Executor,
  repoPath: string,
  upstreamPath: string,
  branch: string,
): Promise<void> {
  if (samePath(repoPath, upstreamPath)) return;
  await run(executor, [
    "git",
    "-C",
    upstreamPath,
    "fetch",
    "--no-tags",
    repoPath,
    `+refs/heads/${branch}:refs/heads/${branch}`,
  ]);
}

/** Discard uncommitted changes (reject). */
export async function discardWorktreeChanges(executor: Executor, path: string): Promise<void> {
  await run(executor, ["git", "-C", path, "reset", "--hard"]);
  await run(executor, ["git", "-C", path, "clean", "-fd"]);
}

/**
 * Remove the worktree when the Task completes or is discarded.
 *
 * `--force` twice, which is git's documented way to remove a *locked* worktree — and the
 * agent's worktree is routinely locked. Claude Code creates its own under `.claude/worktrees`
 * and locks it with its session pid, then does not unlock it when it exits, so by the time a
 * finished Task gets here the lock is held by a process that no longer exists. A single
 * `--force` covers uncommitted changes but refuses a lock outright, which failed the teardown
 * of every run the agent had worktreed for itself.
 *
 * Blanket rather than escalating on failure, because the alternative is reading git's error
 * text to decide — and that text is localized (the report this came from said "impossible de
 * supprimer un arbre de travail verrouillé"). A cleanup that worked only in English would be a
 * worse bug than the one it replaced. The lock is never load-bearing here: SoloW only ever
 * removes a worktree it provisioned or adopted for a Task that is over.
 */
export async function cleanupWorktree(
  executor: Executor,
  repoPath: string,
  worktree: string,
  opts: CleanupOpts = {},
): Promise<void> {
  await run(executor, [
    "git",
    "-C",
    repoPath,
    "worktree",
    "remove",
    "--force",
    "--force",
    worktree,
  ]);
  if (!opts.ownRepository) return;
  /*
   * A Task's own clone goes with its worktree (`ownClone`).
   *
   * Left behind it would be a copy of the whole repository per Task per attachment, growing the
   * cache without bound — and, worse, it holds the Task's committed work, including whatever a
   * discarded round wrote, long after the Task is over. The branch a reviewer approved is not in
   * it by then: `publishWorktreeBranch` has already moved it into the Repository.
   *
   * `rm -rf` is safe here only because the caller cannot choose the path: the directory is the
   * one `taskRepositoryPath` derives from the cache root and the ids, and the flag is set by the
   * same code that asked for the clone. Nothing Owner-authored reaches this argument vector.
   */
  await run(executor, ["rm", "-rf", "--", repoPath]);
}

export interface CleanupOpts {
  /**
   * Remove the repository itself, not just the worktree: true exactly when `repoPath` is the
   * private clone this Task was given rather than a repository the deployment shares.
   */
  ownRepository?: boolean | undefined;
}

/**
 * Per-file summary of what the agent changed, plus the patch itself (TASK-022 diff view).
 *
 * Captured in the orchestrator because it is the only process that has the worktree: the web app
 * must never shell out to git, and in a hosted deployment the worktree is not even on its
 * machine. The result is persisted to the session log, so the diff survives the worktree being
 * torn down — a Done Task can still show what was approved.
 */
export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
}

export interface WorktreeDiff {
  files: DiffFile[];
  patch: string;
  /** True when the patch was cut short; the file list is always complete. */
  truncated: boolean;
}

/**
 * How much patch text to keep. A generated change can run to megabytes, and this lands in a
 * SQLite row that the review page loads in one go. The file list is never truncated — that is
 * what a reviewer scans first, and it is small.
 */
export const DIFF_PATCH_LIMIT = 256 * 1024;

const STATUS_CODES: Record<string, DiffFileStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
};

/** Parse `git diff --numstat`. Binary files report `-` rather than a count. */
function parseNumstat(out: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of out.split("\n")) {
    const [added, removed, ...rest] = line.split("\t");
    const path = rest.join("\t").trim();
    if (!path) continue;
    stats.set(path, {
      additions: Number.parseInt(added ?? "", 10) || 0,
      deletions: Number.parseInt(removed ?? "", 10) || 0,
    });
  }
  return stats;
}

/**
 * The agent's uncommitted work, as a diff against the commit the worktree started from.
 *
 * Two details, both load-bearing:
 *
 * `git add -N` first, so files the agent *created* appear at all — an untracked file is
 * invisible to `git diff`, and "the agent wrote a new module" is exactly the change a reviewer
 * most needs to see. Intent-to-add stages no content, so the later commit or discard is
 * unaffected.
 *
 * Then diff against `HEAD`, not the index. `add -N .` *stages* any deletion it finds, which
 * takes it out of the unstaged diff entirely: a plain `git diff` reported a deleted file as no
 * change at all. Against HEAD both staged and unstaged work is included, so a deletion survives.
 */
export async function diffWorktree(
  executor: Executor,
  path: string,
  setupFilePatterns: string[] = [],
): Promise<WorktreeDiff> {
  // Files copied in by the setup-file allowlist are subtracted from every one of these commands
  // (issue #52 AC-4). They were not authored by the agent, and a reviewer being shown the
  // contents of a `.env` would put a secret on screen — and into any snapshot taken of it.
  const only = ["--", ".", ...setupFileExclusions(setupFilePatterns)];
  await executor.exec(["git", "-C", path, "add", "-N", ...only]);

  const numstat = await run(executor, ["git", "-C", path, "diff", "HEAD", "--numstat", ...only]);
  const nameStatus = await run(executor, [
    "git",
    "-C",
    path,
    "diff",
    "HEAD",
    "--name-status",
    ...only,
  ]);
  const stats = parseNumstat(numstat);

  const files: DiffFile[] = [];
  for (const line of nameStatus.split("\n")) {
    const [code, ...rest] = line.split("\t");
    const filePath = rest[rest.length - 1]?.trim();
    if (!code || !filePath) continue;
    const stat = stats.get(filePath) ?? { additions: 0, deletions: 0 };
    files.push({
      path: filePath,
      status: STATUS_CODES[code.trim()[0] ?? ""] ?? "modified",
      additions: stat.additions,
      deletions: stat.deletions,
    });
  }

  const full = await run(executor, ["git", "-C", path, "diff", "HEAD", ...only]);
  const truncated = full.length > DIFF_PATCH_LIMIT;
  return { files, patch: truncated ? full.slice(0, DIFF_PATCH_LIMIT) : full, truncated };
}
