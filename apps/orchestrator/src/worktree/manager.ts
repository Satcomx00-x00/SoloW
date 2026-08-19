/// <reference types="bun-types" />
import { join } from "node:path";
import type { RepositorySource } from "@gatecontrol/contracts";
import { $ } from "bun";

/**
 * Git worktree manager (spec F08 / task TASK-015). Each Task gets an isolated worktree so
 * concurrent Tasks never share working files (Principle II). Repositories come from a local
 * clone path or a remote URL that is cloned into a cache first (clarified 2026-08-17).
 */

/** Deterministic, collision-free branch name for a Task's worktree. */
export function worktreeBranch(taskId: string): string {
  return `gatecontrol/task-${taskId}`;
}

/** Deterministic worktree directory for a Task. */
export function worktreePath(root: string, taskId: string): string {
  return join(root, taskId);
}

export interface ProvisionParams {
  taskId: string;
  repository: { source: RepositorySource; location: string };
  baseRef?: string | undefined;
  worktreeRoot: string;
  repoCacheRoot: string;
}

export interface Worktree {
  path: string;
  branch: string;
  /** The main repository the worktree was added onto (needed for cleanup). */
  repoPath: string;
}

/** The main repository path a worktree is added onto (local path, or a cached clone). */
async function resolveRepoPath(params: ProvisionParams): Promise<string> {
  if (params.repository.source === "local_path") return params.repository.location;
  // remote_url: clone into the cache once (idempotent), then add worktrees from it.
  const cachePath = join(params.repoCacheRoot, encodeURIComponent(params.repository.location));
  const exists = await Bun.file(join(cachePath, ".git", "HEAD")).exists();
  if (!exists) {
    await $`git clone ${params.repository.location} ${cachePath}`.quiet();
  }
  return cachePath;
}

export async function provisionWorktree(params: ProvisionParams): Promise<Worktree> {
  const repoPath = await resolveRepoPath(params);
  const branch = worktreeBranch(params.taskId);
  const path = worktreePath(params.worktreeRoot, params.taskId);
  const base = params.baseRef ?? "HEAD";
  // Create a new branch for the Task, checked out into its own worktree.
  await $`git -C ${repoPath} worktree add -b ${branch} ${path} ${base}`.quiet();
  return { path, branch, repoPath };
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
export async function prepareRepository(params: ProvisionParams): Promise<string> {
  const repoPath = await resolveRepoPath(params);
  const isRepo = await $`git -C ${repoPath} rev-parse --git-dir`.quiet().nothrow();
  if (isRepo.exitCode !== 0) {
    throw new Error(`not a git repository: ${params.repository.location}`);
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
export async function listWorktrees(repoPath: string): Promise<WorktreeRecord[]> {
  const out = await $`git -C ${repoPath} worktree list --porcelain`.quiet().text();
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
  repoPath: string,
  reportedPath: string | null,
): Promise<Worktree> {
  if (!reportedPath) {
    throw new Error("agent did not report a workspace; cannot confirm an isolated worktree");
  }
  const known = await listWorktrees(repoPath);
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

/** True when the worktree has uncommitted changes (i.e. the agent produced a diff). */
export async function hasChanges(path: string): Promise<boolean> {
  const out = await $`git -C ${path} status --porcelain`.quiet().text();
  return out.trim().length > 0;
}

/** Commit the agent's changes onto the Task's new local branch (no push/PR — spec FR-009). */
export async function commitWorktree(path: string, message: string): Promise<void> {
  await $`git -C ${path} add -A`.quiet();
  await $`git -C ${path} commit -m ${message}`.quiet();
}

/** Discard uncommitted changes (reject). */
export async function discardWorktreeChanges(path: string): Promise<void> {
  await $`git -C ${path} reset --hard`.quiet();
  await $`git -C ${path} clean -fd`.quiet();
}

/** Remove the worktree when the Task completes or is discarded. */
export async function cleanupWorktree(repoPath: string, worktree: string): Promise<void> {
  await $`git -C ${repoPath} worktree remove --force ${worktree}`.quiet();
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
export async function diffWorktree(path: string): Promise<WorktreeDiff> {
  await $`git -C ${path} add -N .`.quiet().nothrow();

  const numstat = await $`git -C ${path} diff HEAD --numstat`.quiet().text();
  const nameStatus = await $`git -C ${path} diff HEAD --name-status`.quiet().text();
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

  const full = await $`git -C ${path} diff HEAD`.quiet().text();
  const truncated = full.length > DIFF_PATCH_LIMIT;
  return { files, patch: truncated ? full.slice(0, DIFF_PATCH_LIMIT) : full, truncated };
}
