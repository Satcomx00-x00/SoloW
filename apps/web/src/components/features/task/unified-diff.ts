/**
 * A unified diff, turned into something a person can read (spec F22 FR-5).
 *
 * The panel used to render the patch as text: `diff --git`, `index b94897d..19f5aff`, `---`,
 * `+++`, `@@ -1,8 +1,8 @@`. That is the output of a command, not a view of a change — four of
 * those six lines are addressed to git, and none of them says which line of the file moved.
 *
 * What an editor shows instead is two files side by side, aligned, numbered, with the changed
 * region highlighted on both sides. Everything below exists to get from the first to the second.
 */

export type DiffLineKind = "context" | "added" | "deleted";

export interface DiffLine {
  kind: DiffLineKind;
  /** Line number in the original file; null on an added line. */
  oldLine: number | null;
  /** Line number in the modified file; null on a deleted line. */
  newLine: number | null;
  text: string;
  /** git's `\ No newline at end of file` applied to this line. */
  noNewline?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  /** The text after `@@ … @@`, which git fills with the enclosing function. Often empty. */
  heading: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  /** The path as the patch names it, best-effort — the file list is the authority. */
  path: string | null;
  hunks: DiffHunk[];
  /** True when the patch carried no `@@` at all: a binary file, or a pure rename. */
  empty: boolean;
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * Parse one file's section of a unified diff.
 *
 * Metadata lines are dropped rather than rendered: `diff --git`, `index`, `similarity`, `---`,
 * `+++`, `new file mode`, and the rest are git talking to git. The only header that carries
 * information for a reader is `@@`, and even that is consumed for its numbers rather than shown.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let path: string | null = null;
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    const match = HUNK.exec(raw);
    if (match) {
      oldLine = Number.parseInt(match[1] ?? "1", 10);
      newLine = Number.parseInt(match[3] ?? "1", 10);
      current = {
        oldStart: oldLine,
        newStart: newLine,
        heading: (match[5] ?? "").trim(),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (raw.startsWith("+++ ")) {
      // The destination path, minus whatever prefix git was configured to write (`b/`, `w/`, …).
      const named = raw.slice(4).trim();
      if (named !== "/dev/null") path = named.replace(/^[a-z]\//, "");
      continue;
    }
    if (
      current === null ||
      raw.startsWith("diff --git") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("old mode") ||
      raw.startsWith("new mode") ||
      raw.startsWith("new file mode") ||
      raw.startsWith("deleted file mode") ||
      raw.startsWith("similarity index") ||
      raw.startsWith("rename from") ||
      raw.startsWith("rename to") ||
      raw.startsWith("Binary files")
    ) {
      continue;
    }
    if (raw.startsWith("\\")) {
      // `\ No newline at end of file` describes the line before it, on whichever side that was.
      const last = current.lines[current.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      current.lines.push({ kind: "added", oldLine: null, newLine: newLine++, text });
    } else if (marker === "-") {
      current.lines.push({ kind: "deleted", oldLine: oldLine++, newLine: null, text });
    } else if (marker === " " || raw === "") {
      // An empty line in the patch is an unchanged empty line in the file: git writes the
      // marker and nothing else, and some tools strip the trailing space.
      current.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text });
    }
  }

  return { path, hunks, empty: hunks.length === 0 };
}

export interface DiffCell {
  line: number | null;
  text: string | null;
  /** Character ranges that differ from the other side, for intra-line highlighting. */
  highlight?: { start: number; end: number };
  noNewline?: boolean;
}

export interface DiffRow {
  kind: "context" | "change" | "added" | "deleted";
  left: DiffCell;
  right: DiffCell;
}

/** Where two strings stop agreeing, from each end. Null when they are identical. */
export function intralineRanges(
  before: string,
  after: string,
): { left: { start: number; end: number }; right: { start: number; end: number } } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) {
    end++;
  }
  // A change that is most of the line is not worth marking as a fragment of it: two entirely
  // different lines highlighted end-to-end read as noise, and the row colour already says it.
  const changed = Math.max(before.length - start - end, after.length - start - end);
  const longest = Math.max(before.length, after.length);
  if (longest > 0 && changed / longest > 0.6) return null;
  return {
    left: { start, end: before.length - end },
    right: { start, end: after.length - end },
  };
}

/**
 * Align a hunk's lines into side-by-side rows.
 *
 * A run of deletions immediately followed by a run of additions is one *change block*: the two
 * runs are paired row by row, which is what makes a rewritten line appear opposite its
 * replacement instead of five rows below it. Whichever run is longer leaves empty cells on the
 * other side, exactly as an editor draws them.
 */
export function toSideBySide(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line) break;
    if (line.kind === "context") {
      const tail = line.noNewline ? { noNewline: true as const } : {};
      rows.push({
        kind: "context",
        left: { line: line.oldLine, text: line.text, ...tail },
        right: { line: line.newLine, text: line.text, ...tail },
      });
      i++;
      continue;
    }
    const deletions: DiffLine[] = [];
    const additions: DiffLine[] = [];
    while (lines[i]?.kind === "deleted") {
      deletions.push(lines[i] as DiffLine);
      i++;
    }
    while (lines[i]?.kind === "added") {
      additions.push(lines[i] as DiffLine);
      i++;
    }

    const height = Math.max(deletions.length, additions.length);
    for (let n = 0; n < height; n++) {
      const removed = deletions[n];
      const added = additions[n];
      const ranges = removed && added ? intralineRanges(removed.text, added.text) : null;
      rows.push({
        kind: removed && added ? "change" : removed ? "deleted" : "added",
        left: {
          line: removed?.oldLine ?? null,
          text: removed?.text ?? null,
          ...(ranges ? { highlight: ranges.left } : {}),
          ...(removed?.noNewline ? { noNewline: true } : {}),
        },
        right: {
          line: added?.newLine ?? null,
          text: added?.text ?? null,
          ...(ranges ? { highlight: ranges.right } : {}),
          ...(added?.noNewline ? { noNewline: true } : {}),
        },
      });
    }
  }
  return rows;
}
