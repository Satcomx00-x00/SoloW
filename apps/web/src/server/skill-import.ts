import "server-only";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  AgentLibraryErrorCode,
  err,
  ok,
  type Result,
  type SkillImportSource,
} from "@solow/contracts";
import { describeSkill } from "@solow/core";
import { unzipSync } from "fflate";
import { childEnv } from "./env.js";

/**
 * Finding every Skill under a directory or in a repository (spec F24): the filesystem and git
 * half of `library.skill.scan`, kept apart from the DAL so it can be tested on a temp directory.
 *
 * A Skill is a directory holding a `SKILL.md` — the shape both runtimes read — and the whole
 * directory is what gets imported, as a `path` source, so the scripts, references and assets
 * beside the file travel with it. The walk stops at a Skill's directory: a `SKILL.md` nested
 * under another is that Skill's own material, not a second entry.
 */

/** Deep enough for `.claude/skills/<name>` inside a monorepo package; not a filesystem crawl. */
const MAX_DEPTH = 8;
const MAX_SKILLS = 200;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const CLONE_TIMEOUT_MS = 120_000;

export type ScannedSkill = {
  name: string;
  description: string;
  path: string;
  relativePath: string;
  files: number;
};

export type ImportError =
  | typeof AgentLibraryErrorCode.ImportSourceNotFound
  | typeof AgentLibraryErrorCode.ImportCloneFailed
  | typeof AgentLibraryErrorCode.ImportArchiveInvalid;

/** Enough for a repository of Skills with their assets; a bomb stops here, not at the disk. */
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/** The URL forms `git clone` takes that are not a bare host path — `file://` included, for tests. */
const GIT_URL = /^(?:(?:https?|ssh|git|file):\/\/\S+|[\w.-]+@[\w.-]+:\S+)$/;

/** `<skillsRoot>/<owner>-<repo>`: one clone per repository, refreshed on the next import. */
export function cloneDirFor(url: string, skillsRoot: string): string {
  const tail = url
    .replace(/\.git\/?$/, "")
    .replace(/[/:]+$/, "")
    .split(/[/:]/)
    .filter(Boolean)
    .slice(-2)
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return join(skillsRoot, tail || "repository");
}

async function git(args: string[], cwd?: string): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], {
    ...(cwd ? { cwd } : {}),
    // A clone that wants a password would otherwise wait on a prompt nobody can answer.
    env: childEnv({ GIT_TERMINAL_PROMPT: "0" }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), CLONE_TIMEOUT_MS);
  try {
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { ok: code === 0, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The directory to scan for a source: the path as given, or the repository's clone — made on
 * the first import, pulled forward on the next, so a team's skills repository is re-imported
 * with one click rather than re-cloned by hand.
 */
export async function resolveImportRoot(
  source: SkillImportSource,
  skillsRoot: string,
): Promise<Result<string, ImportError>> {
  if (source.kind === "path") {
    const root = resolve(source.path);
    const info = await stat(root).catch(() => null);
    return info?.isDirectory() ? ok(root) : err(AgentLibraryErrorCode.ImportSourceNotFound);
  }
  const url = source.url.trim();
  if (!GIT_URL.test(url)) return err(AgentLibraryErrorCode.ImportCloneFailed);
  const dir = cloneDirFor(url, skillsRoot);
  const existing = await stat(join(dir, ".git")).catch(() => null);
  const result = existing
    ? await git(["pull", "--ff-only", "--quiet"], dir)
    : await (async () => {
        await mkdir(skillsRoot, { recursive: true });
        return git(["clone", "--depth", "1", "--quiet", url, dir]);
      })();
  return result.ok ? ok(dir) : err(AgentLibraryErrorCode.ImportCloneFailed);
}

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) n += await countFiles(join(dir, entry.name));
    } else n += 1;
  }
  return n;
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_SKILLS) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    out.push(dir);
    return;
  }
  // Sorted so two scans of one tree list its Skills in one order, whatever the disk returns.
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name)) {
      await walk(join(dir, entry.name), depth + 1, out);
    }
  }
}

/**
 * Every Skill under `root`, named and described from its SKILL.md or, failing that, from its
 * directory — and never two with one name, since the library would refuse the second.
 */
export async function scanSkillDirectories(root: string): Promise<ScannedSkill[]> {
  const dirs: string[] = [];
  await walk(root, 0, dirs);
  const taken = new Set<string>();
  const skills: ScannedSkill[] = [];
  for (const dir of dirs) {
    const relativePath = relative(root, dir) || ".";
    const markdown = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => "");
    const described = describeSkill(
      markdown,
      basename(dir === root ? resolve(root) : dir),
      relativePath,
    );
    let name = described.name;
    for (let i = 2; taken.has(name); i++) name = `${described.name.slice(0, 60)}-${i}`;
    taken.add(name);
    skills.push({
      name,
      description: described.description,
      path: dir,
      relativePath,
      files: await countFiles(dir),
    });
  }
  return skills;
}

/** `<skillsRoot>/<archive name>`: the directory an uploaded zip is unpacked into, replaced on re-upload. */
export function archiveDirFor(fileName: string, skillsRoot: string): string {
  const slug = basename(fileName)
    .replace(/\.zip$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return join(skillsRoot, slug || "archive");
}

/**
 * Unpack a zip into the skills directory and hand back where, for the same scan a directory
 * gets. Every entry's path is checked before a byte is written: an archive is the one source
 * that can name a path outside its own directory (`../`, a drive letter, an absolute path), so
 * one such entry refuses the whole archive rather than skipping the entry — a zip that tries
 * that is not one to import the rest of. Directories are made from the files' paths, so an
 * archive with or without directory entries unpacks the same.
 */
export async function unpackSkillArchive(
  fileName: string,
  bytes: Uint8Array,
  skillsRoot: string,
): Promise<Result<string, ImportError>> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return err(AgentLibraryErrorCode.ImportArchiveInvalid);
  }
  const files = Object.entries(entries).filter(([name]) => !name.endsWith("/"));
  if (files.length === 0 || files.length > MAX_ARCHIVE_ENTRIES) {
    return err(AgentLibraryErrorCode.ImportArchiveInvalid);
  }
  const dir = archiveDirFor(fileName, skillsRoot);
  let total = 0;
  const writes: { path: string; data: Uint8Array }[] = [];
  for (const [name, data] of files) {
    const rel = normalize(name.replace(/\\/g, "/"));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(rel)) {
      return err(AgentLibraryErrorCode.ImportArchiveInvalid);
    }
    total += data.byteLength;
    if (total > MAX_ARCHIVE_BYTES) return err(AgentLibraryErrorCode.ImportArchiveInvalid);
    writes.push({ path: join(dir, rel), data });
  }
  await rm(dir, { recursive: true, force: true });
  for (const { path, data } of writes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  return ok(dir);
}

/** Whether a directory still holds the SKILL.md an import is about to point at. */
export async function holdsSkill(path: string): Promise<boolean> {
  const info = await stat(join(path, "SKILL.md")).catch(() => null);
  return info?.isFile() ?? false;
}
