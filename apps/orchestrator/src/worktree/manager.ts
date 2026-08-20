import { join } from "node:path";
import type { RepositorySource } from "@gatecontrol/contracts";
import { taskCheckoutBranch } from "@gatecontrol/core";
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
 * Delegated to `@gatecontrol/core` rather than spelled out here: the DAL derives the same name
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
const TOKEN_VAR = "GATECONTROL_SCM_TOKEN";

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

/** The main repository path a worktree is added onto (local path, or a cached clone). */
async function resolveRepoPath(executor: Executor, params: ProvisionParams): Promise<string> {
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
 * The Task's worktree, created if it is not already there (issue #58).
 *
 * Idempotent, because the branch name and the directory are both pure functions of the Task id
 * and nothing ever deletes the branch: `cleanupWorktree` removes the directory and leaves
 * `gatecontrol/task-<id>` behind. A second launch of the same Task — a relaunch after a review
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
  const repoPath = await resolveRepoPath(executor, params);
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
 * repository at a time. GateControl still has to resolve *which* repository — a local path is
 * used as-is, a remote URL is cloned into the cache once — and to fail here, before any agent
 * starts, when the repository is unusable (TASK-015: an invalid location fails the Task rather
 * than producing a confusing agent error later).
 */
export async function prepareRepository(
  executor: Executor,
  params: ProvisionParams,
): Promise<string> {
  const repoPath = await resolveRepoPath(executor, params);
  const isRepo = await executor.exec(["git", "-C", repoPath, "rev-parse", "--git-dir"]);
  if (isRepo.exitCode !== 0) {
    throw new RepositoryUnusableError(`not a git repository: ${params.repository.location}`);
  }
  return repoPath;
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

/** Discard uncommitted changes (reject). */
export async function discardWorktreeChanges(executor: Executor, path: string): Promise<void> {
  await run(executor, ["git", "-C", path, "reset", "--hard"]);
  await run(executor, ["git", "-C", path, "clean", "-fd"]);
}

/** Remove the worktree when the Task completes or is discarded. */
export async function cleanupWorktree(
  executor: Executor,
  repoPath: string,
  worktree: string,
): Promise<void> {
  await run(executor, ["git", "-C", repoPath, "worktree", "remove", "--force", worktree]);
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
