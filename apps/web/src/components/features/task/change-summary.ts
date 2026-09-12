import type { TaskDiffDto } from "@solow/contracts";
import { isGeneratedPath, LOCKFILE_NAMES } from "@solow/core";

export { LOCKFILE_NAMES };

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
  /** A tool's output among the changed files — folded under its own group, counted apart. */
  generated: string[];
  /** The lines in those, so the human share of the change can be stated ("+340 of +8 311"). */
  generatedLines: number;
  /** Generated files whose bodies the capture left out to stay within its bound. */
  omitted: string[];
  /** True when the patch was cut short; the file list is always complete. */
  truncated: boolean;
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function summariseDiff(
  diff: Pick<TaskDiffDto, "files" | "truncated"> & { omitted?: string[] | undefined },
): ChangeSummary {
  let additions = 0;
  let deletions = 0;
  let generatedLines = 0;
  const deleted: string[] = [];
  const lockfiles: string[] = [];
  const generated: string[] = [];
  for (const file of diff.files) {
    additions += file.additions;
    deletions += file.deletions;
    if (file.status === "deleted") deleted.push(file.path);
    if (LOCKFILE_NAMES.has(basename(file.path))) lockfiles.push(file.path);
    if (isGeneratedPath(file.path)) {
      generated.push(file.path);
      generatedLines += file.additions + file.deletions;
    }
  }
  return {
    files: diff.files.length,
    additions,
    deletions,
    deleted,
    lockfiles,
    generated,
    generatedLines,
    omitted: diff.omitted ?? [],
    truncated: diff.truncated,
  };
}

/** "+340 −88", the way every diff stat is written. */
export function formatDelta(summary: Pick<ChangeSummary, "additions" | "deletions">): string {
  return `+${summary.additions} −${summary.deletions}`;
}
