import type { TaskDiffDto } from "@solow/contracts";

/**
 * What a captured change amounts to, before anyone reads a line of it.
 *
 * The file list says which files; this says how much, and which of the files are the kind a
 * reviewer wants pointed out rather than found — a deletion in a list of thirty modifications, a
 * lockfile the harness regenerated wholesale, a patch the capture cut short. Pure, so the flags
 * are testable as facts about the diff rather than as pixels.
 */
export interface ChangeSummary {
  files: number;
  additions: number;
  deletions: number;
  /** Paths the harness removed outright. */
  deleted: string[];
  /** Dependency lockfiles among the changed files — churn that is rarely reviewed line by line. */
  lockfiles: string[];
  /** True when the patch was cut short; the file list is always complete. */
  truncated: boolean;
}

/**
 * The lockfile names this build knows. Matched on the basename, so a lockfile anywhere in a
 * monorepo counts. A name added here is a name that starts being flagged — nothing else reads it.
 */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "flake.lock",
]);

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function summariseDiff(diff: Pick<TaskDiffDto, "files" | "truncated">): ChangeSummary {
  let additions = 0;
  let deletions = 0;
  const deleted: string[] = [];
  const lockfiles: string[] = [];
  for (const file of diff.files) {
    additions += file.additions;
    deletions += file.deletions;
    if (file.status === "deleted") deleted.push(file.path);
    if (LOCKFILE_NAMES.has(basename(file.path))) lockfiles.push(file.path);
  }
  return {
    files: diff.files.length,
    additions,
    deletions,
    deleted,
    lockfiles,
    truncated: diff.truncated,
  };
}

/** "+340 −88", the way every diff stat is written. */
export function formatDelta(summary: Pick<ChangeSummary, "additions" | "deletions">): string {
  return `+${summary.additions} −${summary.deletions}`;
}
