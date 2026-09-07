import "server-only";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  err,
  HarnessLibraryErrorCode,
  ok,
  type Result,
  type SkillImportSource,
} from "@solow/contracts";
import { describeSkill } from "@solow/core";
import { unzipSync } from "fflate";

/**
 * Finding every Skill under a directory or in a repository (spec F24): the filesystem and git
 * half of `library.skill.scan`, kept apart from the DAL so it can be tested on a temp directory.
 *
 * A Skill is a directory holding a `SKILL.md` — the shape both runtimes read — and the whole
 * directory is what gets imported, as a `path` source, so the scripts, references and assets
 * beside the file travel with it. The walk stops at a Skill's directory: a `SKILL.md` nested
 * under another is that Skill's own material, not a second entry.
 *
 * A repository is fetched as the archive its host serves over HTTPS, not cloned: this app never
 * spawns a process — host access is the executor's alone (`scripts/audit-executor-boundary.ts`)
 * — and a zip of the default branch is the same tree without a `git` binary, a credential prompt
 * or a `.git` directory the scan would have to skip.
 */

/** Deep enough for `.claude/skills/<name>` inside a monorepo package; not a filesystem crawl. */
const MAX_DEPTH = 8;
const MAX_SKILLS = 200;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const FETCH_TIMEOUT_MS = 120_000;

export type ScannedSkill = {
  name: string;
  description: string;
  path: string;
  relativePath: string;
  files: number;
};

export type ImportError =
  | typeof HarnessLibraryErrorCode.ImportSourceNotFound
  | typeof HarnessLibraryErrorCode.ImportCloneFailed
  | typeof HarnessLibraryErrorCode.ImportArchiveInvalid;

/** Enough for a repository of Skills with their assets; a bomb stops here, not at the disk. */
const MAX_ARCHIVE_ENTRIES = 5000;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;

/**
 * Where a repository's archive is: the URL forms people paste, reduced to host, path and ref.
 * `https://host/owner/repo`, with or without `.git`, or `git@host:owner/repo`; a `#ref` names a
 * branch or tag, and without one the host's default branch (`HEAD`) is asked for.
 */
export function parseRepositoryUrl(
  url: string,
): { host: string; path: string; name: string; ref: string } | null {
  const trimmed = url.trim();
  const [locator, fragment] = trimmed.split("#", 2);
  const ssh = /^[\w.-]+@([\w.-]+):(.+)$/.exec(locator ?? "");
  let host: string;
  let path: string;
  if (ssh?.[1] && ssh[2]) {
    host = ssh[1];
    path = ssh[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(locator ?? "");
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    host = parsed.host;
    path = parsed.pathname;
  }
  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  const segments = path.split("/").filter(Boolean);
  if (!host || segments.length < 2) return null;
  const ref = (fragment ?? "").trim() || "HEAD";
  if (!/^[\w./-]+$/.test(ref)) return null;
  return { host, path: segments.join("/"), name: segments[segments.length - 1] as string, ref };
}

/**
 * The archive URLs to try, in order. GitHub serves every repository from `codeload`; anything
 * else is asked the GitLab way first and the Gitea way second, which between them cover the
 * self-hosted forges a team keeps its skills on.
 */
export function archiveUrlsFor(repo: {
  host: string;
  path: string;
  name: string;
  ref: string;
}): string[] {
  const ref = encodeURIComponent(repo.ref).replace(/%2F/g, "/");
  if (repo.host === "github.com" || repo.host === "www.github.com") {
    return [`https://codeload.github.com/${repo.path}/zip/${ref}`];
  }
  return [
    `https://${repo.host}/${repo.path}/-/archive/${ref}/${repo.name}-${ref.replace(/\//g, "-")}.zip`,
    `https://${repo.host}/${repo.path}/archive/${ref}.zip`,
  ];
}

/** `<skillsRoot>/<owner>-<repo>`: one directory per repository, replaced on the next fetch. */
export function cloneDirFor(url: string, skillsRoot: string): string {
  const tail = url
    .split("#", 1)[0]
    ?.replace(/\.git\/?$/, "")
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

async function fetchArchive(urls: string[], fetchImpl: typeof fetch): Promise<Uint8Array | null> {
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
      if (!res.ok) continue;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > MAX_ARCHIVE_BYTES) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_ARCHIVE_BYTES) return null;
      return bytes;
    } catch {
      // The next URL form may be the one this host speaks.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * The directory to scan for a source: the path as given, or the repository's archive unpacked
 * under the skills root — fetched again on every scan, so a team's skills repository is
 * re-imported with one click rather than re-downloaded by hand. `fetchImpl` is a seam for tests.
 */
export async function resolveImportRoot(
  source: SkillImportSource,
  skillsRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<string, ImportError>> {
  if (source.kind === "path") {
    const root = resolve(source.path);
    const info = await stat(root).catch(() => null);
    return info?.isDirectory() ? ok(root) : err(HarnessLibraryErrorCode.ImportSourceNotFound);
  }
  const repo = parseRepositoryUrl(source.url);
  if (!repo) return err(HarnessLibraryErrorCode.ImportCloneFailed);
  const bytes = await fetchArchive(archiveUrlsFor(repo), fetchImpl);
  if (!bytes) return err(HarnessLibraryErrorCode.ImportCloneFailed);
  const unpacked = await unpackArchiveInto(cloneDirFor(source.url, skillsRoot), bytes);
  return unpacked.ok ? unpacked : err(HarnessLibraryErrorCode.ImportCloneFailed);
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
  return unpackArchiveInto(archiveDirFor(fileName, skillsRoot), bytes);
}

async function unpackArchiveInto(
  dir: string,
  bytes: Uint8Array,
): Promise<Result<string, typeof HarnessLibraryErrorCode.ImportArchiveInvalid>> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
  }
  const files = Object.entries(entries).filter(([name]) => !name.endsWith("/"));
  if (files.length === 0 || files.length > MAX_ARCHIVE_ENTRIES) {
    return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
  }
  let total = 0;
  const writes: { path: string; data: Uint8Array }[] = [];
  for (const [name, data] of files) {
    const rel = normalize(name.replace(/\\/g, "/"));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || /^[A-Za-z]:/.test(rel)) {
      return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
    }
    total += data.byteLength;
    if (total > MAX_ARCHIVE_BYTES) return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
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
