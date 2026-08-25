import type { ScmFileDto, ScmWorktreeDto, TaskDiffDto } from "@gatecontrol/contracts";

/**
 * The source-control panel over a *captured* diff (spec F22, "the worktree is gone").
 *
 * F22's live path reads git through the orchestrator. This is the fallback the same spec
 * requires: an approved Task's worktree has been cleaned up, and the only account of what it
 * held is the record captured at the gate — and now, at every turn boundary. The panel renders
 * that account with the same grouping and the same rows, read-only, and says which it is showing.
 *
 * Read-only is not a limitation being apologised for here: there is no working tree behind these
 * rows to stage anything into.
 */

const LETTER: Record<TaskDiffDto["files"][number]["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

export function scmFromCapturedDiff(diff: TaskDiffDto, reason: string): ScmWorktreeDto {
  const files: ScmFileDto[] = diff.files.map((file) => ({
    path: file.path,
    // Every captured file is an uncommitted working-tree change: the capture runs before the
    // gate commits anything, so nothing in it has been staged in the sense the panel means.
    group: "changes",
    kind: file.status,
    letter: LETTER[file.status] ?? "M",
    additions: file.additions,
    deletions: file.deletions,
    binary: false,
  }));
  return {
    // No attachment is recorded on a captured diff, and none is needed: every write path checks
    // `writable` first, and this worktree is never writable.
    attachmentId: diff.repositoryId ?? "",
    repositoryId: diff.repositoryId ?? "",
    repositoryName: diff.repositoryName ?? "",
    branch: {
      name: diff.diffRef,
      detached: false,
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
    },
    files,
    total: files.length,
    // The file list of a capture is always complete; only the patch is ever cut (`diff.truncated`).
    truncated: false,
    writable: false,
    readOnlyReason: reason,
  };
}

/**
 * Split a unified diff into the section belonging to each file.
 *
 * The header cannot be parsed by stripping `a/` and `b/`: git writes whatever prefixes it is
 * configured to write, and **mnemonic prefixes** (`diff.mnemonicPrefix`) turn them into `c/` and
 * `w/` — commit and worktree — which is exactly what this repository's own captures contain. A
 * splitter that assumed `a/`/`b/` would silently match nothing and show every file an empty diff.
 *
 * So the header is matched against the paths the capture already lists, by suffix. The file list
 * is authoritative; the header only has to point at one of its entries.
 */
export function splitPatchByFile(patch: string, paths: string[]): Map<string, string> {
  const sections = new Map<string, string>();
  if (patch === "") return sections;

  const lines = patch.split("\n");
  let current: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (current !== null) sections.set(current, buffer.join("\n"));
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      // Longest match wins, so `src/a.ts` is not claimed by a header naming `a.ts`.
      current =
        paths
          .filter(
            (p) => line.endsWith(`/${p}`) || line.endsWith(` ${p}`) || line.includes(`/${p} `),
          )
          .sort((a, b) => b.length - a.length)[0] ?? null;
    }
    if (current !== null) buffer.push(line);
  }
  flush();
  return sections;
}
