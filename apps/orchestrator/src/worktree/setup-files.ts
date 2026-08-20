import { dirname, join, resolve, sep } from "node:path";
import type { Executor } from "../executor/types.js";

/**
 * Setup files: the per-Repository allowlist of files copied into each new worktree (issue #52 /
 * parity row 52).
 *
 * A fresh worktree carries only what is committed, so it has no `.env` — and an agent without
 * one cannot run the test suite or start the dev server, and spends its first turns discovering
 * that. Copying a named handful of files is the difference between an agent that can verify its
 * own work and one that can only guess.
 *
 * This moves secrets by design, so three things are deliberate:
 *
 * - **Allowlist only.** Never "copy everything git-ignored", which would sweep in credentials,
 *   caches and build output indiscriminately (AC-2).
 * - **Nothing is logged but counts.** Not the contents, and not the resolved file list — a log
 *   line reading `.env.production` is a small leak with a large blast radius (Principle IV,
 *   AC-3). An unmatched *pattern* is reported, because that is configuration the operator typed,
 *   not a fact about what exists on disk.
 * - **Matching is done by git, inside the repository.** Pathspecs are repository-relative by
 *   construction, so no pattern can name a file outside it, and the result is re-checked against
 *   the repository root anyway (AC-6).
 *
 * Copied files are excluded from the review diff by `diffWorktree`, which takes the same
 * patterns: they were not authored by the agent, and showing them would put secrets in front of
 * the review UI and into any shareable snapshot (AC-4, row 16).
 */

export interface SeedSetupFilesParams {
  /** The repository the worktree was created from; the source of every copied file. */
  repoPath: string;
  /** The worktree the agent is working in; the destination. */
  worktreePath: string;
  /** Repository-relative globs, already validated by `setupFilePatternSchema`. */
  patterns: string[];
}

export interface SetupFileSeedResult {
  /** How many files were copied. A count, never a list — see the module note on AC-3. */
  copied: number;
  /** Patterns that matched nothing: a warning, not a failure (AC-5). */
  unmatched: string[];
  /** How many matched files could not be copied. Also a warning; the run continues. */
  failed: number;
}

/**
 * Files matching one pattern, as repository-relative paths.
 *
 * Two queries because a single `git ls-files` cannot answer both halves: `--cached` covers
 * tracked files, and `--others --ignored` covers the ignored ones — which is where a `.env`
 * actually lives, and the whole point of the feature.
 *
 * `:(glob)` asks for real glob semantics, so `**` spans directories and `*` does not; without it
 * git applies fnmatch without `FNM_PATHNAME` and the two behave differently. The pattern is
 * passed after `--`, so it is never read as an option however it starts.
 */
async function matchPattern(
  executor: Executor,
  repoPath: string,
  pattern: string,
): Promise<string[]> {
  const spec = `:(glob)${pattern}`;
  const queries = [
    ["git", "-C", repoPath, "ls-files", "-z", "--cached", "--", spec],
    [
      "git",
      "-C",
      repoPath,
      "ls-files",
      "-z",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--",
      spec,
    ],
  ];

  const paths = new Set<string>();
  for (const cmd of queries) {
    const result = await executor.exec(cmd);
    // A pathspec git dislikes is a bad pattern, not a broken repository: skip it and let the
    // caller report the pattern as unmatched.
    if (result.exitCode !== 0) continue;
    for (const entry of result.stdout.split("\0")) {
      if (entry.length > 0) paths.add(entry);
    }
  }
  return [...paths];
}

/** True when `relativePath` resolves inside `root` — the last check before anything is read (AC-6). */
function withinRoot(root: string, relativePath: string): boolean {
  const base = resolve(root);
  const target = resolve(base, relativePath);
  return target === base || target.startsWith(base + sep);
}

/**
 * Copy every file matching the Repository's patterns from the repository into the worktree.
 *
 * Never throws. A missing file, an unreadable one, a pattern that matches nothing — none of them
 * should fail a Task that would otherwise run: a repository configured on a machine that lacks
 * one of the files should still work, just with less for the agent to go on (AC-5).
 */
export async function seedSetupFiles(
  executor: Executor,
  params: SeedSetupFilesParams,
): Promise<SetupFileSeedResult> {
  const result: SetupFileSeedResult = { copied: 0, unmatched: [], failed: 0 };
  if (params.patterns.length === 0) return result;

  // Deduplicated across patterns: two globs that overlap should copy a file once, not twice.
  const seen = new Set<string>();

  for (const pattern of params.patterns) {
    const matches = await matchPattern(executor, params.repoPath, pattern);
    if (matches.length === 0) {
      result.unmatched.push(pattern);
      continue;
    }
    for (const relativePath of matches) {
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      // git yields repository-relative paths, so this cannot normally fail — which is exactly
      // why it is cheap to assert, and why a future non-git matcher inherits the jail.
      if (
        !withinRoot(params.repoPath, relativePath) ||
        !withinRoot(params.worktreePath, relativePath)
      ) {
        result.failed += 1;
        continue;
      }
      const from = join(params.repoPath, relativePath);
      const to = join(params.worktreePath, relativePath);
      const mkdir = await executor.exec(["mkdir", "-p", dirname(to)]);
      if (mkdir.exitCode !== 0) {
        result.failed += 1;
        continue;
      }
      // `-p` keeps the mode: a private key copied world-readable would be a worse outcome than
      // not copying it at all.
      const copy = await executor.exec(["cp", "-p", from, to]);
      if (copy.exitCode !== 0) result.failed += 1;
      else result.copied += 1;
    }
  }

  return result;
}

/**
 * Pathspecs that hide the copied files from a diff.
 *
 * Expressed as the patterns themselves rather than as the resolved paths, so nothing has to
 * carry a list of secret-bearing filenames from the copy step to the diff step — the exclusion
 * is recomputed from configuration each time, and is correct even for a file the agent created
 * at a path the allowlist covers.
 */
export function setupFileExclusions(patterns: string[]): string[] {
  return patterns.map((pattern) => `:(exclude,glob)${pattern}`);
}
