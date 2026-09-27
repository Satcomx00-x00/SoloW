import "server-only";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  err,
  HarnessLibraryErrorCode,
  ok,
  type Result,
  type SkillImportSource,
} from "@solow/contracts";
import { describeSkill, parseSkillLocator, type SkillLocator, skillSlug } from "@solow/core";
import { gunzipSync, unzipSync } from "fflate";

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
 *
 * The same rule is why the installer CLIs (`npx skills add`, `npx skills-installer`, `npx
 * add-skill`) are not run but *emulated*: `parseSkillLocator` (in `@solow/core`) reads what they
 * read, and `resolveSkillLocator` below fetches what they fetch — a checkout and a directory in
 * it, a `.zip` or `.tar.gz`, one `SKILL.md`, or a site's `/.well-known/agent-skills/` index —
 * over HTTPS, into `SOLOW_SKILLS_ROOT`, where the scan then finds the Skills like any other tree.
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
  | typeof HarnessLibraryErrorCode.ImportArchiveInvalid
  | typeof HarnessLibraryErrorCode.ImportLocatorInvalid;

/** Where to scan, and — when the locator named Skills — which of what is found to keep. */
export type ResolvedImport = { root: string; skills: string[] };

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
  // Azure Repos (`org/project/_git/repo`, on dev.azure.com or a DevOps Server) serves a zip of
  // the tree from its items API; the default branch is what it gives with no version named.
  const azure = /^(.+)\/_git\/([^/]+)$/.exec(repo.path);
  if (azure?.[1] && azure[2]) {
    const version =
      repo.ref === "HEAD" ? "" : `&versionDescriptor.version=${encodeURIComponent(repo.ref)}`;
    return [
      `https://${repo.host}/${azure[1]}/_apis/git/repositories/${azure[2]}/items?path=/&$format=zip&download=true&resolveLfs=true&api-version=7.1${version}`,
    ];
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

/** The first of `urls` that answers 2xx within the size cap, as bytes; null when none does. */
async function fetchBytes(
  urls: string[],
  fetchImpl: typeof fetch,
  limit = MAX_ARCHIVE_BYTES,
): Promise<Uint8Array | null> {
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { redirect: "follow", signal: controller.signal });
      if (!res.ok) continue;
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > limit) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > limit) return null;
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
 *
 * A `git` URL and a `locator` go through the same reading (`parseSkillLocator`), so the
 * repository field takes a `/tree/` URL or `owner/repo` too; only a local path is refused there,
 * since the field said "repository".
 */
export async function resolveImportSource(
  source: SkillImportSource,
  skillsRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<ResolvedImport, ImportError>> {
  if (source.kind === "path") return resolvePath(source.path, []);
  const locator = parseSkillLocator(source.kind === "git" ? source.url : source.locator);
  if (!locator) {
    return err(
      source.kind === "git"
        ? HarnessLibraryErrorCode.ImportCloneFailed
        : HarnessLibraryErrorCode.ImportLocatorInvalid,
    );
  }
  if (source.kind === "git" && locator.kind === "path") {
    return err(HarnessLibraryErrorCode.ImportCloneFailed);
  }
  return resolveSkillLocator(locator, skillsRoot, fetchImpl);
}

/**
 * Fetch what a locator points at into the skills root and say where to scan — the work
 * `npx skills add` does before it copies files, minus the copying, since the library reads the
 * directory in place.
 */
export async function resolveSkillLocator(
  locator: SkillLocator,
  skillsRoot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Result<ResolvedImport, ImportError>> {
  switch (locator.kind) {
    case "path":
      return resolvePath(locator.path, locator.skills);
    case "repository":
      return resolveRepository(locator, skillsRoot, fetchImpl);
    case "download":
      return resolveDownload(locator.url, locator.skills, skillsRoot, fetchImpl);
    case "url": {
      // A self-hosted forge, a site with a well-known index, or a file: whichever answers first.
      const repo = parseRepositoryUrl(locator.url);
      if (repo) {
        const bytes = await fetchBytes(archiveUrlsFor(repo), fetchImpl);
        if (bytes) return unpackCheckout(cloneDirFor(locator.url, skillsRoot), bytes, locator);
      }
      const wellKnown = await resolveWellKnown(locator, skillsRoot, fetchImpl);
      // An index that was there but lied (a digest mismatch) is an answer, not a miss.
      if (wellKnown.ok || wellKnown.error === HarnessLibraryErrorCode.ImportArchiveInvalid) {
        return wellKnown;
      }
      return resolveDownload(locator.url, locator.skills, skillsRoot, fetchImpl);
    }
  }
}

async function resolvePath(
  path: string,
  skills: string[],
): Promise<Result<ResolvedImport, ImportError>> {
  const root = resolve(
    path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path,
  );
  const info = await stat(root).catch(() => null);
  return info?.isDirectory()
    ? ok({ root, skills })
    : err(HarnessLibraryErrorCode.ImportSourceNotFound);
}

async function resolveRepository(
  locator: Extract<SkillLocator, { kind: "repository" }>,
  skillsRoot: string,
  fetchImpl: typeof fetch,
): Promise<Result<ResolvedImport, ImportError>> {
  const repo = parseRepositoryUrl(locator.ref ? `${locator.url}#${locator.ref}` : locator.url);
  if (!repo) return err(HarnessLibraryErrorCode.ImportCloneFailed);
  const bytes = await fetchBytes(archiveUrlsFor(repo), fetchImpl);
  if (!bytes) return err(HarnessLibraryErrorCode.ImportCloneFailed);
  return unpackCheckout(cloneDirFor(locator.url, skillsRoot), bytes, locator);
}

/**
 * A fetched checkout, unpacked, with the locator's directory found inside it. Forges wrap the
 * tree in one `repo-ref/` directory, so that is stepped into first. A directory that is not
 * there is read the way skills-installer spells `owner/repo/skill`: its parent is scanned and
 * its name is what to keep.
 */
async function unpackCheckout(
  dir: string,
  bytes: Uint8Array,
  locator: { subpath?: string | null; skills: string[] },
): Promise<Result<ResolvedImport, ImportError>> {
  const unpacked = await unpackArchiveInto(dir, bytes);
  if (!unpacked.ok) return err(HarnessLibraryErrorCode.ImportCloneFailed);
  const top = await archiveTop(unpacked.data);
  if (!locator.subpath) return ok({ root: top, skills: locator.skills });
  const wanted = resolve(top, locator.subpath);
  if (!wanted.startsWith(top + sep)) return err(HarnessLibraryErrorCode.ImportSourceNotFound);
  if ((await stat(wanted).catch(() => null))?.isDirectory()) {
    return ok({ root: wanted, skills: locator.skills });
  }
  const parent = dirname(wanted);
  if ((await stat(parent).catch(() => null))?.isDirectory()) {
    return ok({ root: parent, skills: [...locator.skills, basename(wanted).toLowerCase()] });
  }
  return err(HarnessLibraryErrorCode.ImportSourceNotFound);
}

/** The one directory a forge's archive wraps the tree in, when there is exactly one. */
async function archiveTop(dir: string): Promise<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const [only] = entries;
  return entries.length === 1 && only?.isDirectory() ? join(dir, only.name) : dir;
}

/** The dubious-in-a-URL characters gone, for a directory named after a URL's segment. */
function segmentSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** A single `SKILL.md` is at most this; anything larger is not a playbook. */
const MAX_SKILL_MD_BYTES = 2 * 1024 * 1024;

/**
 * A file served as-is: an archive of Skills, unpacked under its own name, or one `SKILL.md`,
 * written into a directory named after the one it sat in — `…/deploy/SKILL.md` becomes
 * `<skillsRoot>/deploy/SKILL.md`, and a raw-file URL from a forge keeps that directory's name.
 */
async function resolveDownload(
  url: string,
  skills: string[],
  skillsRoot: string,
  fetchImpl: typeof fetch,
): Promise<Result<ResolvedImport, ImportError>> {
  const bytes = await fetchBytes([url], fetchImpl);
  if (!bytes) return err(HarnessLibraryErrorCode.ImportCloneFailed);
  const segments = urlSegments(url);
  if (looksLikeArchive(bytes)) {
    const name = segmentSlug(
      (segments[segments.length - 1] ?? "").replace(/\.(zip|tgz|tar\.gz)$/i, ""),
    );
    const unpacked = await unpackArchiveInto(join(skillsRoot, name || "download"), bytes);
    return unpacked.ok ? ok({ root: unpacked.data, skills }) : unpacked;
  }
  if (bytes.byteLength > MAX_SKILL_MD_BYTES || !looksLikeText(bytes)) {
    return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
  }
  const last = segments[segments.length - 1] ?? "";
  const named = /^skill\.md$/i.test(last)
    ? segments[segments.length - 2]
    : last.replace(/\.md$/i, "");
  const dir = join(skillsRoot, segmentSlug(named ?? "") || "skill");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), bytes);
  return ok({ root: dir, skills });
}

function urlSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return [];
  }
}

function looksLikeArchive(bytes: Uint8Array): boolean {
  return isZip(bytes) || isGzip(bytes);
}

/** Markdown, not a binary someone linked by mistake: no NUL in the first kilobyte. */
function looksLikeText(bytes: Uint8Array): boolean {
  return !bytes.subarray(0, 1024).includes(0);
}

// ---- Well-known skills (RFC 8615: `/.well-known/agent-skills/index.json`) ----

const WELL_KNOWN_PATHS = [".well-known/agent-skills", ".well-known/skills"];
const WELL_KNOWN_INDEX_BYTES = 2 * 1024 * 1024;

type WellKnownEntry =
  | { name: string; description: string; files: string[] }
  | {
      name: string;
      description: string;
      type: "skill-md" | "archive";
      url: string;
      digest?: string;
    };

type WellKnownIndex = {
  indexUrl: string;
  base: string;
  wellKnownPath: string;
  entries: WellKnownEntry[];
};

/**
 * A site's index, from the path given first (`https://host/docs` may publish its own) and the
 * origin second, at the current path then the legacy one — the order the `skills` CLI probes in.
 */
async function fetchWellKnownIndex(
  url: string,
  fetchImpl: typeof fetch,
): Promise<WellKnownIndex | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  const bases = path ? [`${parsed.origin}${path}`, parsed.origin] : [parsed.origin];
  for (const wellKnownPath of WELL_KNOWN_PATHS) {
    for (const base of bases) {
      const indexUrl = `${base}/${wellKnownPath}/index.json`;
      const bytes = await fetchBytes([indexUrl], fetchImpl, WELL_KNOWN_INDEX_BYTES);
      if (!bytes) continue;
      const entries = readWellKnownIndex(bytes);
      if (entries) return { indexUrl, base, wellKnownPath, entries };
    }
  }
  return null;
}

function readWellKnownIndex(bytes: Uint8Array): WellKnownEntry[] | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const skills = (json as { skills?: unknown })?.skills;
  if (!Array.isArray(skills)) return null;
  const entries: WellKnownEntry[] = [];
  for (const raw of skills) {
    const e = raw as Record<string, unknown>;
    if (typeof e?.name !== "string" || !e.name) continue;
    const description = typeof e.description === "string" ? e.description : "";
    if ((e.type === "skill-md" || e.type === "archive") && typeof e.url === "string") {
      entries.push({
        name: e.name,
        description,
        type: e.type,
        url: e.url,
        ...(typeof e.digest === "string" ? { digest: e.digest } : {}),
      });
    } else if (Array.isArray(e.files)) {
      entries.push({
        name: e.name,
        description,
        files: e.files.filter((f): f is string => typeof f === "string"),
      });
    }
  }
  return entries;
}

/** `sha256:<hex>` as the discovery schema writes it; anything else is not checked. */
async function digestMatches(bytes: Uint8Array, digest: string | undefined): Promise<boolean> {
  const hex = /^sha256:([0-9a-f]{64})$/i.exec(digest ?? "")?.[1];
  if (!hex) return true;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  const actual = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  return actual === hex.toLowerCase();
}

/**
 * Every Skill a site publishes — or the ones the locator named — fetched into one directory per
 * site under the skills root, and the ones named that the index lacks left for the caller to
 * report as missing. A v0.2.0 entry is one artifact (a `SKILL.md` or an archive, checked against
 * its digest when it carries one); a v0.1.0 entry is a file list under `<well-known>/<name>/`.
 */
async function resolveWellKnown(
  locator: { url: string; skills: string[] },
  skillsRoot: string,
  fetchImpl: typeof fetch,
): Promise<Result<ResolvedImport, ImportError>> {
  const index = await fetchWellKnownIndex(locator.url, fetchImpl);
  if (!index) return err(HarnessLibraryErrorCode.ImportCloneFailed);
  const wanted = new Set(locator.skills);
  const entries = index.entries
    .filter(
      (e) => wanted.size === 0 || wanted.has(e.name.toLowerCase()) || wanted.has(skillSlug(e.name)),
    )
    .slice(0, MAX_SKILLS);
  const dir = join(skillsRoot, segmentSlug(index.base.replace(/^https?:\/\//, "")) || "well-known");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const entry of entries) {
    const name = skillSlug(entry.name);
    if (!name) continue;
    const target = join(dir, name);
    if ("files" in entry) {
      const base = `${index.base}/${index.wellKnownPath}/${encodeURIComponent(entry.name)}`;
      const markdown = await fetchBytes([`${base}/SKILL.md`], fetchImpl, MAX_SKILL_MD_BYTES);
      if (!markdown) continue;
      const writes: { path: string; data: Uint8Array }[] = [{ path: "SKILL.md", data: markdown }];
      for (const file of entry.files.slice(0, MAX_ARCHIVE_ENTRIES)) {
        const rel = safeRelativePath(file);
        if (!rel || rel.toLowerCase() === "skill.md") continue;
        const data = await fetchBytes(
          [`${base}/${file.split("/").map(encodeURIComponent).join("/")}`],
          fetchImpl,
        );
        if (data) writes.push({ path: rel, data });
      }
      await writeTree(target, writes);
      continue;
    }
    let artifactUrl: string;
    try {
      artifactUrl = new URL(entry.url, index.indexUrl).toString();
    } catch {
      continue;
    }
    const bytes = await fetchBytes([artifactUrl], fetchImpl);
    if (!bytes) continue;
    if (!(await digestMatches(bytes, entry.digest))) {
      return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
    }
    if (entry.type === "archive") {
      const unpacked = await unpackArchiveInto(target, bytes);
      if (!unpacked.ok) return unpacked;
    } else {
      await writeTree(target, [{ path: "SKILL.md", data: bytes }]);
    }
  }
  return ok({ root: dir, skills: locator.skills });
}

/** A path from an index or an archive, relative and inside its directory, or null. */
function safeRelativePath(name: string): string | null {
  const rel = normalize(name.replace(/\\/g, "/"));
  if (
    !rel ||
    rel === "." ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    /^[A-Za-z]:/.test(rel)
  ) {
    return null;
  }
  return rel;
}

async function writeTree(dir: string, writes: { path: string; data: Uint8Array }[]): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  for (const { path, data } of writes) {
    const full = join(dir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, data);
  }
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
  const entries = readArchive(bytes);
  if (!entries) return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
  const files = Object.entries(entries).filter(([name]) => !name.endsWith("/"));
  if (files.length === 0 || files.length > MAX_ARCHIVE_ENTRIES) {
    return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
  }
  let total = 0;
  const writes: { path: string; data: Uint8Array }[] = [];
  for (const [name, data] of files) {
    const rel = safeRelativePath(name);
    if (!rel) return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
    total += data.byteLength;
    if (total > MAX_ARCHIVE_BYTES) return err(HarnessLibraryErrorCode.ImportArchiveInvalid);
    writes.push({ path: rel, data });
  }
  await writeTree(dir, writes);
  return ok(dir);
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * The files in a `.zip` or a `.tar.gz`, by path — the two shapes a forge, a release page or a
 * well-known index serves a tree as. Told apart by their magic bytes, not the URL, since a
 * download link rarely ends in the right extension.
 */
function readArchive(bytes: Uint8Array): Record<string, Uint8Array> | null {
  try {
    if (isGzip(bytes)) return untar(gunzipSync(bytes));
    return unzipSync(bytes);
  } catch {
    return null;
  }
}

/**
 * A POSIX/ustar tar, read the plain way: 512-byte headers, the size in octal, a `prefix` field
 * for long paths, and a GNU `././@LongLink` entry naming the next file. Only regular files are
 * kept — a symlink in a Skill would point somewhere the scan should not follow anyway.
 */
export function untar(bytes: Uint8Array): Record<string, Uint8Array> {
  const decoder = new TextDecoder();
  const field = (at: number, len: number) => {
    const raw = bytes.subarray(at, at + len);
    const end = raw.indexOf(0);
    return decoder.decode(end < 0 ? raw : raw.subarray(0, end));
  };
  const out: Record<string, Uint8Array> = {};
  let longName: string | null = null;
  for (let offset = 0; offset + 512 <= bytes.byteLength; ) {
    if (bytes.subarray(offset, offset + 512).every((b) => b === 0)) break;
    const size = Number.parseInt(field(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(bytes[offset + 156] ?? 0x30);
    const prefix = field(offset + 257, 6) === "ustar" ? field(offset + 345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${field(offset, 100)}` : field(offset, 100));
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    longName = null;
    if (type === "L") longName = decoder.decode(data).replace(/\0+$/, "");
    else if ((type === "0" || type === "\0" || type === "") && name) out[name] = data;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Whether a directory still holds the SKILL.md an import is about to point at. */
export async function holdsSkill(path: string): Promise<boolean> {
  const info = await stat(join(path, "SKILL.md")).catch(() => null);
  return info?.isFile() ?? false;
}
