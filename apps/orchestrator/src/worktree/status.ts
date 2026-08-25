import type { ScmBranchDto, ScmChangeKind, ScmFileDto, ScmGroup } from "@gatecontrol/contracts";
import type { Executor } from "../executor/types.js";
import { setupFileExclusions } from "./setup-files.js";

/**
 * A worktree's source control, read from git (spec F22, Decision 0017).
 *
 * Separate from `diffWorktree` in `manager.ts` on purpose. That function answers one question —
 * "what has the agent changed, as a patch" — and answers it for the review gate, which wants a
 * durable artefact. This one answers "what does git say right now, file by file, and which list
 * does each file belong in", which is a panel's question and has to survive being asked again a
 * second later.
 *
 * Everything here goes through `Executor.exec`, so a Docker (#96) or SSH (#97) executor inherits
 * it unchanged (F22 NFR-1, NFR-6).
 */

/** How many entries the panel will render before the response says it was cut (F22 NFR-2). */
export const SCM_FILE_LIMIT = 2000;

export interface ScmWorktreeStatus {
  branch: ScmBranchDto;
  files: ScmFileDto[];
  total: number;
  truncated: boolean;
}

async function git(executor: Executor, cwd: string, args: string[]): Promise<string> {
  const result = await executor.exec(["git", "-C", cwd, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * Split a `-z` stream into its records.
 *
 * `-z` rather than line mode throughout, because a filename may legally contain a newline, and
 * the line-mode alternative is git quoting the path — which would have to be unquoted here,
 * badly, for the one case that matters least. A trailing empty field from the final NUL is
 * dropped; an empty field anywhere else would be a path of length zero, which git does not emit.
 */
function records(out: string): string[] {
  const parts = out.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * The letter a row shows and the kind the product names, from one porcelain-v2 status code.
 *
 * Git's code is two characters — index state then worktree state — and the panel shows one row
 * per non-`.` half. `M.` is staged-modified; `.M` is modified-not-staged; `MM` is both, and
 * produces two rows, which is what git means and what an editor draws.
 */
const KIND_BY_CODE: Record<string, ScmChangeKind> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

function kindOf(code: string): ScmChangeKind {
  return KIND_BY_CODE[code] ?? "modified";
}

/**
 * `git status --porcelain=v2 --branch -z`, parsed.
 *
 * Porcelain **v2** rather than v1 for two reasons that both bite in practice: it carries the
 * branch header (name, upstream, ahead/behind) in the same call, and it reports a rename's
 * original path as a field rather than as an ` -> ` inside the path, which is unparseable for a
 * filename containing that sequence.
 *
 * The one subtlety worth stating: with `-z`, a rename record (`2 …`) spans **two** NUL-delimited
 * fields — the new path, then the original. A parser that advances one record at a time reads
 * the original path as the next file and produces a phantom entry, which is the classic way to
 * get this wrong.
 */
export function parsePorcelainV2(out: string): { branch: ScmBranchDto; files: ScmFileDto[] } {
  const branch: ScmBranchDto = {
    name: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const files: ScmFileDto[] = [];
  const push = (
    path: string,
    group: ScmGroup,
    kind: ScmChangeKind,
    letter: string,
    originalPath?: string,
  ) => {
    files.push({
      path,
      ...(originalPath ? { originalPath } : {}),
      group,
      kind,
      letter,
      additions: null,
      deletions: null,
      binary: false,
    });
  };

  const rows = records(out);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? "";
    if (row.startsWith("# branch.")) {
      const [key, ...rest] = row.slice("# branch.".length).split(" ");
      const value = rest.join(" ");
      if (key === "oid") branch.head = value === "(initial)" ? null : value.slice(0, 8);
      else if (key === "head") {
        branch.detached = value === "(detached)";
        branch.name = branch.detached ? null : value;
      } else if (key === "upstream") branch.upstream = value;
      else if (key === "ab") {
        // `+N -M`, always both, always signed.
        const [ahead, behind] = value.split(" ");
        branch.ahead = Math.abs(Number.parseInt(ahead ?? "0", 10) || 0);
        branch.behind = Math.abs(Number.parseInt(behind ?? "0", 10) || 0);
      }
      continue;
    }
    if (row.startsWith("? ")) {
      push(row.slice(2), "untracked", "untracked", "?");
      continue;
    }
    if (row.startsWith("! ")) continue; // ignored; the panel does not show these
    if (row.startsWith("u ")) {
      // Unmerged. The code's two halves describe each side of the conflict; the row is one
      // entry in Merge Changes either way, because a conflict is not something to stage.
      const fields = row.split(" ");
      push(fields.slice(10).join(" "), "merge", "conflicted", "U");
      continue;
    }
    if (row.startsWith("1 ") || row.startsWith("2 ")) {
      const renamed = row.startsWith("2 ");
      const fields = row.split(" ");
      const code = fields[1] ?? "..";
      // `1` has 8 leading fields before the path; `2` has 9 (the rename score joins them).
      const path = fields.slice(renamed ? 9 : 8).join(" ");
      // A rename record's original path is the *next* NUL-delimited field, not the next record.
      const originalPath = renamed ? rows[++i] : undefined;
      const index = code[0] ?? ".";
      const worktree = code[1] ?? ".";
      if (index !== ".") push(path, "staged", kindOf(index), index, originalPath);
      if (worktree !== ".") push(path, "changes", kindOf(worktree), worktree, originalPath);
    }
  }
  return { branch, files };
}

/**
 * `git diff --numstat`, parsed into per-path counts.
 *
 * A binary file reports `-` for both halves rather than a number, which is how it is detected —
 * git is the only thing here that knows, and asking it a second way would be a second answer.
 */
export function parseNumstatZ(
  out: string,
): Map<string, { added: number | null; removed: number | null }> {
  const stats = new Map<string, { added: number | null; removed: number | null }>();
  // `--numstat -z` terminates each record with NUL and, for renames, emits the two paths as two
  // further NUL-delimited fields. The rename case is keyed on the new path, which is what the
  // status read named the row.
  const parts = records(out);
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i] ?? "";
    const [addedRaw, removedRaw, ...rest] = record.split("\t");
    if (addedRaw === undefined || removedRaw === undefined) continue;
    let path = rest.join("\t");
    if (path === "") {
      // A rename: the record ended after the counts, and the two paths follow as their own fields.
      i += 1; // the original path
      path = parts[++i] ?? "";
    }
    if (!path) continue;
    const added = addedRaw === "-" ? null : Number.parseInt(addedRaw, 10) || 0;
    const removed = removedRaw === "-" ? null : Number.parseInt(removedRaw, 10) || 0;
    stats.set(path, { added, removed });
  }
  return stats;
}

/**
 * Read one worktree's source control.
 *
 * Three git calls, and deliberately no more: the status, the unstaged counts, and the staged
 * counts. A per-file diff is what the panel asks for when a row is clicked, not something to
 * compute for every row of a change nobody has opened yet.
 *
 * The setup-file allowlist (issue #52) is excluded from all three, exactly as the captured diff
 * excludes it — a `.env` the agent needed to run the tests is not part of what it proposed, and
 * putting it on screen would put a secret on screen (Principle IV, F22 FR-17).
 */
export async function readScmStatus(
  executor: Executor,
  path: string,
  setupFilePatterns: string[] = [],
  limit: number = SCM_FILE_LIMIT,
): Promise<ScmWorktreeStatus> {
  const only = ["--", ".", ...setupFileExclusions(setupFilePatterns)];
  const [statusOut, unstagedOut, stagedOut] = await Promise.all([
    git(executor, path, ["status", "--porcelain=v2", "--branch", "-z", ...only]),
    git(executor, path, ["diff", "--numstat", "-z", ...only]),
    git(executor, path, ["diff", "--cached", "--numstat", "-z", ...only]),
  ]);

  const { branch, files } = parsePorcelainV2(statusOut);
  const unstaged = parseNumstatZ(unstagedOut);
  const staged = parseNumstatZ(stagedOut);

  for (const file of files) {
    const stat = file.group === "staged" ? staged.get(file.path) : unstaged.get(file.path);
    if (!stat) continue;
    file.binary = stat.added === null;
    file.additions = stat.added;
    file.deletions = stat.removed;
  }

  const total = files.length;
  return {
    branch,
    files: files.slice(0, limit),
    total,
    truncated: total > limit,
  };
}
