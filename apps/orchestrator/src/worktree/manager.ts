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
