import type { ScmFileDto } from "@gatecontrol/contracts";

/**
 * The tree presentation of a change (spec F22 FR-4).
 *
 * A flat list answers "what changed"; a tree answers "where". On a change that touches thirty
 * files across four packages the flat list is thirty paths sharing long prefixes, and the shape
 * of the work is invisible in the repetition.
 *
 * Single-child directory chains are collapsed into one row — `src/components/features` rather
 * than three rows each containing only the next — which is what every editor does and what keeps
 * a deep repository from reading as a staircase.
 */

export type ScmTreeNode =
  | { kind: "directory"; path: string; label: string; children: ScmTreeNode[] }
  | { kind: "file"; path: string; file: ScmFileDto };

interface MutableDir {
  dirs: Map<string, MutableDir>;
  files: ScmFileDto[];
}

function emptyDir(): MutableDir {
  return { dirs: new Map(), files: [] };
}

/**
 * Directories before files, each alphabetical and case-insensitive.
 *
 * Case-insensitive because a reviewer scanning for `Readme.md` should not have to know whether
 * the repository capitalised it — byte order would file every capitalised name in a block of its
 * own, which is sorting the ASCII table rather than the change.
 */
function byName(a: ScmTreeNode, b: ScmTreeNode): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  const left = a.kind === "directory" ? a.label : a.path;
  const right = b.kind === "directory" ? b.label : b.path;
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

function toNodes(dir: MutableDir, prefix: string): ScmTreeNode[] {
  const nodes: ScmTreeNode[] = [];
  for (const [name, child] of dir.dirs) {
    let label = name;
    let path = prefix ? `${prefix}/${name}` : name;
    let current = child;
    // Collapse a chain of directories that each hold exactly one directory and nothing else.
    while (current.files.length === 0 && current.dirs.size === 1) {
      const [nextName, nextDir] = [...current.dirs.entries()][0] as [string, MutableDir];
      label = `${label}/${nextName}`;
      path = `${path}/${nextName}`;
      current = nextDir;
    }
    nodes.push({ kind: "directory", path, label, children: toNodes(current, path) });
  }
  for (const file of dir.files) nodes.push({ kind: "file", path: file.path, file });
  return nodes.sort(byName);
}

/**
 * Build the tree for one group's files.
 *
 * Per group, not per worktree: a file that is staged *and* modified again appears in two groups,
 * and one tree spanning both would have to render it twice under the same parent with no way to
 * tell the rows apart.
 */
export function buildScmTree(files: ScmFileDto[]): ScmTreeNode[] {
  const root = emptyDir();
  for (const file of files) {
    const segments = file.path.split("/").filter((s) => s !== "");
    const name = segments.pop();
    if (name === undefined) continue;
    let dir = root;
    for (const segment of segments) {
      let next = dir.dirs.get(segment);
      if (!next) {
        next = emptyDir();
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.push(file);
  }
  return toNodes(root, "");
}

/** The file's own name, and the directory part a list row shows de-emphasised beside it. */
export function splitPath(path: string): { name: string; parent: string } {
  const cut = path.lastIndexOf("/");
  return cut === -1
    ? { name: path, parent: "" }
    : { name: path.slice(cut + 1), parent: path.slice(0, cut) };
}
