/**
 * Where a Skill is, read the way the installer CLIs read it (spec F24).
 *
 * People find a Skill on skills.sh, in a README or in a chat, and what they hold is one of a
 * dozen spellings: `owner/repo`, `owner/repo@skill`, `github:owner/repo/path`, a `/tree/` URL, a
 * skills.sh page, `git@host:owner/repo.git`, a `.zip`, a raw `SKILL.md`, or the whole
 * `npx skills add …` line the README told them to run. `npx skills`, `npx skills-installer`,
 * `npx add-skill` and their kin all take those; the library should take no less, so the operator
 * pastes what they have and SoloW works out the rest.
 *
 * This is the parsing half, pure and shared: it turns text into a `SkillLocator` and nothing
 * else. Fetching — an archive over HTTPS, a well-known index, a file — is `apps/web`'s
 * `skill-import`, which never spawns the CLI it is emulating: host access is the executor's alone.
 */

export type SkillLocator = {
  /**
   * The Skills asked for by name — `--skill a,b`, `owner/repo@name`, `#ref@name` — matched
   * against what the source holds. Empty: every Skill the source holds.
   */
  skills: string[];
} & (
  | { kind: "path"; path: string }
  /**
   * A repository on a forge: `url` is `https://host/owner/repo` with no `.git`, `ref` a branch,
   * tag or null for the default branch, `subpath` a directory inside the checkout or null for
   * its root. Where a `/blob/…/SKILL.md` URL was given, `subpath` is that file's directory.
   */
  | { kind: "repository"; url: string; ref: string | null; subpath: string | null }
  /** One `SKILL.md`, or a `.zip`/`.tar.gz` holding Skills, served as-is over HTTPS. */
  | { kind: "download"; url: string }
  /**
   * An HTTPS URL on no forge this recognises: a repository on a self-hosted forge, a site
   * publishing `/.well-known/agent-skills/`, or a download. The resolver tries them in that order.
   */
  | { kind: "url"; url: string }
);

/** The `npx`-style launchers a pasted command may start with, longest first. */
const RUNNERS = [
  ["pnpm", "dlx"],
  ["pnpm", "exec"],
  ["yarn", "dlx"],
  ["npm", "exec"],
  ["npm", "x"],
  ["npx"],
  ["bunx"],
  ["pnpx"],
];

/** `skills`, `skills@latest`, `skills-installer`, `add-skill`, `@vercel/skills`, `npm:skills`… */
const TOOL_RE = /^(npm:)?(@[\w.-]+\/)?[\w.-]*skill[\w.-]*(@[\w.^~<>=*-]+)?$/i;
const VERBS = new Set(["add", "install", "i", "a"]);

/** Flags that eat the next word: the Skill selection, a ref, and the targets we do not need. */
const SKILL_FLAGS = new Set(["--skill", "--skills", "-s"]);
const REF_FLAGS = new Set(["--ref", "--branch", "-b"]);
const IGNORED_VALUE_FLAGS = new Set([
  "--agent",
  "-a",
  "--client",
  "-c",
  "--target",
  "--dir",
  "--cwd",
]);

/** A shell line into words, honouring `'…'` and `"…"` the way a README's install line uses them. */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of line.matchAll(re)) words.push(m[1] ?? m[2] ?? m[3] ?? "");
  return words;
}

/**
 * The text an operator pasted, whichever it is: a locator on its own, or an install command
 * whose locator and `--skill` selection are read out of it. Null when neither is recognised.
 */
export function parseSkillLocator(input: string): SkillLocator | null {
  const text = input.trim().replace(/^\$\s+/, "");
  if (!text) return null;
  if (!/\s/.test(text)) return parseLocator(text);

  const words = splitCommandLine(text);
  let i = 0;
  for (const runner of RUNNERS) {
    if (runner.every((w, k) => words[i + k] === w)) {
      i += runner.length;
      break;
    }
  }
  while (words[i] === "-y" || words[i] === "--yes" || words[i] === "--") i++;
  if (words[i] && TOOL_RE.test(words[i] as string)) i++;
  if (words[i] && VERBS.has(words[i] as string)) i++;

  const skills: string[] = [];
  let ref: string | null = null;
  let locator: SkillLocator | null = null;
  for (; i < words.length; i++) {
    const word = words[i] as string;
    const eq = word.startsWith("-") ? word.indexOf("=") : -1;
    const flag = eq > 0 ? word.slice(0, eq) : word;
    const value = eq > 0 ? word.slice(eq + 1) : null;
    if (SKILL_FLAGS.has(flag)) {
      skills.push(...skillNames(value ?? words[++i] ?? ""));
    } else if (REF_FLAGS.has(flag)) {
      ref = value ?? words[++i] ?? null;
    } else if (IGNORED_VALUE_FLAGS.has(flag)) {
      if (value === null) i++;
    } else if (flag.startsWith("-")) {
      // A switch (`-g`, `--copy`, `--all`, `--global`…): nothing this needs.
    } else if (!locator) {
      // The first word that reads as a locator; a stray word from an unknown flag does not.
      locator = parseLocator(word);
    }
  }
  if (!locator) return null;
  if (ref && locator.kind === "repository" && !locator.ref) locator = { ...locator, ref };
  return { ...locator, skills: unique([...locator.skills, ...skills]) };
}

/** `a,b c` → `["a", "b", "c"]`; `*` (the CLIs' "every one") → nothing to filter by. */
function skillNames(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== "*");
}

function unique(names: string[]): string[] {
  return [...new Set(names.map((n) => n.toLowerCase()))];
}

function isLocalPath(s: string): boolean {
  return (
    s.startsWith("/") ||
    s.startsWith("./") ||
    s.startsWith("../") ||
    s === "." ||
    s === ".." ||
    s === "~" ||
    s.startsWith("~/") ||
    /^[A-Za-z]:[/\\]/.test(s)
  );
}

/** A directory inside a checkout, forward-slashed, with nothing that climbs out of it. */
function subpathOf(segments: string[]): string | null | undefined {
  const cleaned = segments.map((s) => decode(s)).filter((s) => s && s !== ".");
  if (cleaned.some((s) => s === ".." || s.includes("\\"))) return undefined;
  // A URL to the SKILL.md itself names its directory.
  if (cleaned[cleaned.length - 1]?.toLowerCase() === "skill.md") cleaned.pop();
  return cleaned.length ? cleaned.join("/") : null;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const REF_RE = /^[\w./-]+$/;

/**
 * `#ref`, or `#ref@skill` / `#@skill` — the fragment the `skills` CLI reads on any git source.
 * Kept off local paths and downloads, where a `#` is part of the name.
 */
function splitFragment(s: string): { locator: string; ref: string | null; skill: string | null } {
  const hash = s.indexOf("#");
  if (hash < 0) return { locator: s, ref: null, skill: null };
  const fragment = decode(s.slice(hash + 1));
  const at = fragment.indexOf("@");
  const ref = at < 0 ? fragment : fragment.slice(0, at);
  const skill = at < 0 ? null : fragment.slice(at + 1) || null;
  return { locator: s.slice(0, hash), ref: ref || null, skill };
}

function parseLocator(raw: string): SkillLocator | null {
  const text = raw.trim();
  if (!text) return null;
  if (isLocalPath(text)) return { kind: "path", path: text, skills: [] };

  const { locator, ref, skill } = splitFragment(text);
  if (ref && !REF_RE.test(ref)) return null;
  const skills = skill ? [skill.toLowerCase()] : [];
  const withRef = (parsed: SkillLocator | null): SkillLocator | null => {
    if (!parsed) return null;
    const merged = { ...parsed, skills: unique([...parsed.skills, ...skills]) };
    return merged.kind === "repository" && ref && !merged.ref ? { ...merged, ref } : merged;
  };

  // `github:owner/repo[/path][@skill]`, `gitlab:group/repo` — the CLIs' prefix shorthands.
  const prefixed = /^(github|gitlab):(.+)$/i.exec(locator);
  if (prefixed?.[2]) {
    const host = (prefixed[1] as string).toLowerCase();
    return withRef(
      host === "github" // provider-branch-ok: parsing the text prefix the operator typed
        ? parseShorthand(prefixed[2])
        : parseUrl(`https://gitlab.com/${prefixed[2].replace(/^\/+/, "")}`),
    );
  }
  if (/^(https?:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:)/i.test(locator)) return withRef(parseUrl(locator));
  // `@owner/repo/skill` is how skills-installer spells it; the `@` says nothing else.
  return withRef(parseShorthand(locator.replace(/^@(?=[^/@]+\/)/, "")));
}

/** `owner/repo`, `owner/repo/path/in/repo`, `owner/repo@skill` — GitHub, as every CLI assumes. */
function parseShorthand(s: string): SkillLocator | null {
  if (/[\s:@]/.test(s.replace(/@[^/]*$/, "")) || s.startsWith(".") || s.startsWith("/")) {
    return null;
  }
  const at = /^([^/@]+)\/([^/@]+)@([^/@]+)$/.exec(s);
  if (at?.[1] && at[2] && at[3]) {
    if (!isRepoName(at[1]) || !isRepoName(at[2])) return null;
    return {
      kind: "repository",
      url: `https://github.com/${at[1]}/${at[2].replace(/\.git$/, "")}`,
      ref: null,
      subpath: null,
      skills: [at[3].toLowerCase()],
    };
  }
  const segments = s.replace(/\/+$/, "").split("/");
  const [owner, repo] = segments;
  if (!owner || !repo || !isRepoName(owner) || !isRepoName(repo) || /@/.test(s)) return null;
  const subpath = subpathOf(segments.slice(2));
  if (subpath === undefined) return null;
  return {
    kind: "repository",
    url: `https://github.com/${owner}/${repo.replace(/\.git$/, "")}`,
    ref: null,
    subpath,
    skills: [],
  };
}

const DOWNLOAD_RE = /\.(zip|tgz|tar\.gz)$/i;

/** An owner or repository segment: what a forge would accept, and never `.` or `..`. */
function isRepoName(s: string): boolean {
  return /^[\w.-]+$/.test(s) && s !== "." && s !== "..";
}

function repository(
  host: string,
  path: string[],
  ref: string | null,
  subpath: string | null,
  skills: string[] = [],
): SkillLocator | null {
  if (!path.every(isRepoName)) return null;
  return {
    kind: "repository",
    url: `https://${host}/${path.join("/").replace(/\.git$/, "")}`,
    ref,
    subpath,
    skills,
  };
}

function parseUrl(s: string): SkillLocator | null {
  // `git@host:owner/repo.git`, `ssh://git@host[:port]/owner/repo.git`: the archive is on the
  // same host over HTTPS, which is the only way this app reaches a forge.
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(s);
  if (scp?.[1] && scp[2]) {
    const path = scp[2].replace(/^\/+|\/+$/g, "").split("/");
    return path.length >= 2 ? repository(scp[1], path, null, null) : null;
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  if (url.protocol === "ssh:") {
    return segments.length >= 2 ? repository(host, segments, null, null) : null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const [owner, repo, marker, refSeg, ...rest] = segments;

  if (host === "github.com" || host === "www.github.com") {
    if (!owner || !repo) return null;
    const archive = marker === "archive" || marker === "releases" || marker === "raw";
    if (archive && marker !== "raw") return { kind: "download", url: s, skills: [] };
    if ((marker === "tree" || marker === "blob" || marker === "raw") && refSeg) {
      const subpath = subpathOf(rest);
      return subpath === undefined
        ? null
        : repository("github.com", [owner, repo], decode(refSeg), subpath);
    }
    return marker ? null : repository("github.com", [owner, repo], null, null);
  }
  if (host === "raw.githubusercontent.com") {
    // `/owner/repo/<ref>/path/SKILL.md`, or `/owner/repo/refs/heads/<branch>/…`: the file's
    // directory in the repository holds the Skill's other files too, so fetch the checkout.
    if (!owner || !repo || !marker) return null;
    const viaRefs = marker === "refs" && (refSeg === "heads" || refSeg === "tags") && rest[0];
    const ref = viaRefs ? (rest[0] as string) : marker;
    const path = viaRefs ? rest.slice(1) : refSeg ? [refSeg, ...rest] : [];
    if (path[path.length - 1]?.toLowerCase() !== "skill.md") {
      return { kind: "download", url: s, skills: [] };
    }
    const subpath = subpathOf(path);
    return subpath === undefined ? null : repository("github.com", [owner, repo], ref, subpath);
  }
  if (host === "codeload.github.com" || host === "objects.githubusercontent.com") {
    return { kind: "download", url: s, skills: [] };
  }
  if (host === "skills.sh" || host === "www.skills.sh") {
    // `skills.sh/owner/repo/skill` is the page behind `npx skills add owner/repo --skill skill`.
    if (!owner || !repo || owner === "p") return { kind: "url", url: s, skills: [] };
    return repository(
      "github.com",
      [owner, repo],
      null,
      null,
      marker ? [marker.toLowerCase()] : [],
    );
  }

  // GitLab's `/-/tree/<ref>/<path>`, `/-/blob/<ref>/<path>`, `/-/archive/…`, on any host.
  const dash = segments.indexOf("-");
  if (dash > 0 && segments[dash + 1]) {
    const what = segments[dash + 1];
    const path = segments.slice(0, dash);
    if (what === "archive" || what === "raw") return { kind: "download", url: s, skills: [] };
    if ((what === "tree" || what === "blob") && segments[dash + 2]) {
      const subpath = subpathOf(segments.slice(dash + 3));
      return subpath === undefined || path.length < 2
        ? null
        : repository(host, path, decode(segments[dash + 2] as string), subpath);
    }
    return null;
  }

  // Azure Repos: `/org/project/_git/repo?path=/skills&version=GBmain`.
  const git = segments.indexOf("_git");
  if (git > 0 && segments[git + 1]) {
    const version = url.searchParams.get("version");
    const ref = version ? (/^G[BT](.+)$/i.exec(version)?.[1] ?? null) : null;
    const subpath = subpathOf((url.searchParams.get("path") ?? "").split("/"));
    return subpath === undefined
      ? null
      : repository(host, segments.slice(0, git + 2), ref, subpath);
  }

  if (DOWNLOAD_RE.test(url.pathname) || /\/skill\.md$/i.test(url.pathname)) {
    return { kind: "download", url: s, skills: [] };
  }
  if (host === "gitlab.com" || url.pathname.endsWith(".git")) {
    return segments.length >= 2 ? repository(host, segments, null, null) : null;
  }
  return { kind: "url", url: `${url.origin}${url.pathname}`.replace(/\/+$/, ""), skills: [] };
}

/**
 * A Skill the locator asked for by name, matched the way the CLIs match `--skill`: against the
 * name in the frontmatter (as the library would slug it) and against the directory's own name,
 * case-insensitively, so `--skill React-Best-Practices` finds `react-best-practices`.
 */
export function skillMatchesRequest(
  requested: string[],
  skill: { name: string; relativePath: string },
): boolean {
  if (requested.length === 0) return true;
  const dir = skill.relativePath.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  return requested.some((r) => r === skill.name.toLowerCase() || r === dir);
}
