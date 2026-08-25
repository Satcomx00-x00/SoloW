import { isAbsolute, normalize } from "node:path";
import type { Executor } from "../executor/types.js";
import { readScmStatus } from "./status.js";

/**
 * The writes the source-control panel makes (spec F22 FR-6, Decision 0017).
 *
 * There is no commit here, and no push. Staging is the review selection; the gate is what turns
 * a selection into a commit (F22 FR-7). A function in this file that wrote to a branch would be
 * a path from agent output to a remote with no recorded decision, which is the one thing
 * Principle I does not permit.
 */

/** A path the client asked to act on, refused before it can reach an argument vector. */
export class PathRefusedError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`refused path: ${reason}`);
    this.name = "PathRefusedError";
  }
}

/**
 * Refuse anything that is not a plain relative path inside the worktree.
 *
 * This is the *lexical* half of F22 NFR-3, and on its own it would not be enough — a symlink
 * defeats every syntactic check ever written. What makes the guarantee hold is that every
 * operation below is expressed as a git command scoped to the worktree with `--`, and git is
 * the one deciding what the path means:
 *
 *  - `git add` **stages a symlink as a link**, recording its target as file content. It does not
 *    follow it and cannot be made to read the file it points at.
 *  - `git restore` and `git clean` refuse a pathspec that resolves outside the work tree, and
 *    `clean` removes the link rather than what it points to.
 *
 * So the containment is git's, verified by tests that actually build the escape, rather than a
 * `realpath` reimplemented here — which would be a second answer to a question git already
 * answers correctly, and the second answer is the one that would be wrong.
 */
export function assertContained(path: string): string {
  if (path.length === 0) throw new PathRefusedError(path, "empty");
  if (path.includes("\0")) throw new PathRefusedError(path, "contains NUL");
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path)) throw new PathRefusedError(path, "absolute");
  // Normalise first: `a/../../b` only reveals itself as an escape after the segments collapse.
  const normalised = normalize(path).replaceAll("\\", "/");
  if (normalised === ".." || normalised.startsWith("../")) {
    throw new PathRefusedError(path, "traverses above the worktree root");
  }
  // A leading `-` would be read as a flag. `--` separates in every command below, but a path
  // that only works because of a separator is one refactor from not working.
  if (normalised.startsWith("-")) throw new PathRefusedError(path, "starts with a dash");
  return normalised;
}

async function git(executor: Executor, cwd: string, args: string[]): Promise<void> {
  const result = await executor.exec(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
}

/** `git add`, which is what "stage" means and what the gate will later commit. */
export async function stagePaths(
  executor: Executor,
  worktreePath: string,
  paths: string[],
): Promise<void> {
  const safe = paths.map(assertContained);
  if (safe.length === 0) return;
  await git(executor, worktreePath, ["add", "--", ...safe]);
}

/**
 * `git restore --staged`: take it back out of the selection, leaving the work alone.
 *
 * Unstaging must never touch the working tree. A reviewer removing a file from what they are
 * about to approve is saying "not this time", not "throw this away" — and conflating the two
 * would destroy an agent's work on a mis-click, with nothing to restore it from.
 */
export async function unstagePaths(
  executor: Executor,
  worktreePath: string,
  paths: string[],
): Promise<void> {
  const safe = paths.map(assertContained);
  if (safe.length === 0) return;
  await git(executor, worktreePath, ["restore", "--staged", "--", ...safe]);
}

/**
 * Discard, which means two different things and has to do both (F22 FR-11).
 *
 * For a tracked file it is a revert to HEAD — index and working tree together, because a file
 * that is staged *and* modified would otherwise be half-discarded. For an untracked file it is a
 * deletion, and there is no commit to recover it from. Which one applies is read from git rather
 * than guessed, and the confirmation the panel shows says which words apply.
 */
export async function discardPaths(
  executor: Executor,
  worktreePath: string,
  paths: string[],
  setupFilePatterns: string[] = [],
): Promise<void> {
  const safe = paths.map(assertContained);
  if (safe.length === 0) return;

  const status = await readScmStatus(
    executor,
    worktreePath,
    setupFilePatterns,
    Number.MAX_SAFE_INTEGER,
  );
  const untracked = new Set(status.files.filter((f) => f.group === "untracked").map((f) => f.path));
  const toDelete = safe.filter((p) => untracked.has(p));
  const toRevert = safe.filter((p) => !untracked.has(p));

  // Revert first. A path that is both — impossible from one status read, but reachable if the
  // tree changed underneath — is then reverted rather than deleted, which is the recoverable
  // half of the two.
  if (toRevert.length > 0) {
    await git(executor, worktreePath, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ...toRevert,
    ]);
  }
  if (toDelete.length > 0) {
    // `-f` only: `-d` would remove directories the client never named.
    await git(executor, worktreePath, ["clean", "-f", "--", ...toDelete]);
  }
}
