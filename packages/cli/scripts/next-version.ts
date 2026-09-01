/// <reference types="bun-types" />
/**
 * What version the commits since the last release say this one should be.
 *
 * The number used to be decided by hand in the pull request that earned it. That is a defensible
 * place for it, and it had one failure mode that mattered: it is a step a human has to remember at
 * exactly the right moment, and forgetting it is silent — the merge lands, `release.yml` finds the
 * tag already there, and reports "nothing to release" for a change that plainly deserved one.
 *
 * So the commits decide instead. They already say what kind of change each one is — this
 * repository has written Conventional Commits throughout — and that vocabulary is precisely a
 * semver vocabulary. Reading it is the whole of this file.
 *
 * **It lives here, in a module with tests, rather than in the workflow's shell.** The mapping from
 * commits to a number is the only part of the release that can be wrong without failing: a bad
 * regex does not error, it ships 0.4.2 where 0.5.0 was meant, and nothing downstream can tell.
 * Shell inside YAML cannot be unit-tested; this can, and is.
 */

/** What the commits since the last release justify. Null when none of them justify anything. */
export type Bump = "major" | "minor" | "patch" | null;

/**
 * A Conventional Commits subject: `type(optional scope)!: description`.
 *
 * The `!` is the breaking marker, and it is captured rather than merely allowed — it is one of the
 * two ways a commit declares a breaking change (the other being a `BREAKING CHANGE:` footer).
 */
const SUBJECT = /^(?<type>[a-zA-Z]+)(?:\([^)]*\))?(?<breaking>!)?:\s/;

/**
 * The footer form, which is what a commit uses when the break needs explaining rather than
 * marking. Both spellings are in the specification; the hyphenated one exists because git
 * trailers cannot contain spaces in the key.
 *
 * Anchored per line (`m`) because a footer is a line of its own — matching it anywhere in the body
 * would let a commit that *discusses* a breaking change be read as making one.
 */
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

/**
 * Which types move which digit.
 *
 * `perf` sits with `fix` deliberately: it changes behaviour a consumer can observe (a call that
 * was slow is now fast, and its timing may be being relied on), which is more than `chore` or
 * `docs` and less than `feat`. Every other type — `chore`, `docs`, `test`, `refactor`, `style`,
 * `build`, `ci` — is releasable but not release-*worthy*: it moves no digit, and a run of them
 * cuts no release at all. That is the behaviour that keeps a documentation typo from publishing to
 * npm.
 */
const TYPE_BUMP: Readonly<Record<string, Exclude<Bump, "major" | null>>> = {
  feat: "minor",
  fix: "patch",
  perf: "patch",
};

const RANK: Readonly<Record<Exclude<Bump, null>, number>> = { patch: 1, minor: 2, major: 3 };

/**
 * The largest bump any one of these commits asks for.
 *
 * The *largest*, not the last: a release carrying one `feat` among twenty `fix`es is a minor
 * release, and the order they were written in says nothing about that.
 *
 * A message that is not a Conventional Commit at all contributes nothing rather than failing. Merge
 * commits ("Merge pull request #132 from …") are the common case and the caller already excludes
 * them, but a hand-written commit from before the convention was adopted must not be able to stop
 * a release either.
 */
export function bumpFor(messages: readonly string[]): Bump {
  let best: Bump = null;
  for (const message of messages) {
    const bump = bumpForOne(message);
    if (bump && (!best || RANK[bump] > RANK[best])) best = bump;
  }
  return best;
}

function bumpForOne(message: string): Bump {
  const trimmed = message.trim();
  if (trimmed === "") return null;
  const groups = SUBJECT.exec(trimmed)?.groups;
  const type = groups?.["type"];
  if (type === undefined) return null;
  // A breaking change outranks whatever type declared it: `fix!:` is a major, not a patch.
  if (groups?.["breaking"] || BREAKING_FOOTER.test(trimmed)) return "major";
  return TYPE_BUMP[type.toLowerCase()] ?? null;
}

/** `x.y.z`, and nothing else. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Apply a bump to a version, with the one rule that surprises people.
 *
 * **Below 1.0.0, a breaking change bumps the minor rather than the major.** 0.4.1 with a `feat!`
 * becomes 0.5.0, not 1.0.0. This is what semantic-release and changesets both do by default, and
 * the reason is that 1.0.0 is not a fact about a diff — it is a declaration that the interface is
 * now stable and that breaking it will cost a major. No commit message can make that promise on a
 * maintainer's behalf, so nothing here promotes a project out of 0.x. Reaching 1.0.0 is a hand
 * edit to `packages/cli/package.json`, made deliberately, once.
 *
 * Throws on a version this cannot reason about — a prerelease or build suffix — rather than
 * guessing. Silently dropping `-rc.1` would publish a release over the one it was a candidate for.
 */
export function applyBump(current: string, bump: Bump): string | null {
  if (bump === null) return null;
  const parsed = VERSION.exec(current.trim());
  if (!parsed) {
    throw new Error(`next-version: cannot bump "${current}" — expected a plain x.y.z version`);
  }
  const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
  const effective = bump === "major" && major === 0 ? "minor" : bump;
  if (effective === "major") return `${major + 1}.0.0`;
  if (effective === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** The version these commits say should follow `current`, or null when they justify no release. */
export function nextVersion(current: string, messages: readonly string[]): string | null {
  return applyBump(current, bumpFor(messages));
}

/**
 * The manifest's own top-level `"version"` line, and only that one.
 *
 * Two spaces of indentation is what makes it the top-level field rather than one nested inside
 * `publishConfig` or a dependency map, and the line anchor is what keeps it from matching a
 * version that happens to appear inside some other string.
 */
const VERSION_FIELD = /^( {2}"version": ")([^"]+)(")/m;

/**
 * The manifest with its version replaced, and nothing else touched.
 *
 * A textual replacement rather than `JSON.parse` → `JSON.stringify`, because the round trip is not
 * lossless in the ways that matter to a file people read: it re-indents, it reorders nothing but
 * re-escapes everything, and it turned the em dash in this package's own description into
 * `—` the first time it was tried. A release commit must contain the version and nothing a
 * reviewer has to look twice at.
 *
 * Throws when the field is not found, rather than returning the source unchanged — a release that
 * silently failed to write the version would tag a manifest that still claims the old one, and
 * `publish.yml`'s guard would then refuse the publish after the tag was already pushed.
 */
export function withVersion(source: string, next: string): string {
  if (!VERSION_FIELD.test(source)) {
    throw new Error('next-version: no top-level "version" field found in the manifest');
  }
  return source.replace(VERSION_FIELD, `$1${next}$3`);
}

/**
 * Every commit message in a range, as whole messages rather than subjects.
 *
 * `-z` because a commit body contains blank lines and can contain anything else a separator might
 * have been: NUL is the one byte a commit message cannot hold, so it is the one safe record
 * separator. `--no-merges` because a merge commit's subject is generated by git ("Merge pull
 * request #132 from …") and describes no change of its own — the commits it brings in are in the
 * range already, and are the ones that say what happened.
 */
function messagesIn(range: string): string[] {
  const proc = Bun.spawnSync(["git", "log", "-z", "--no-merges", "--format=%B", range]);
  if (proc.exitCode !== 0) {
    throw new Error(`next-version: git log ${range} failed: ${proc.stderr.toString().trim()}`);
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const at = args.indexOf("--since");
  // Empty or absent means "no release has been cut yet", so every commit in history counts.
  const since = at === -1 ? "" : (args[at + 1] ?? "");
  const range = since === "" ? "HEAD" : `${since}..HEAD`;

  const manifest = new URL("../package.json", import.meta.url).pathname;
  const source = await Bun.file(manifest).text();
  const current = (JSON.parse(source) as { version: string }).version;

  const next = nextVersion(current, messagesIn(range));
  // `--write` puts the number in the manifest as well as printing it, so the caller cannot end up
  // having tagged a version the manifest does not carry.
  if (next && args.includes("--write")) await Bun.write(manifest, withVersion(source, next));
  // Printed alone on stdout so a workflow can read it with `$(…)`; nothing at all when the commits
  // justify no release, which is the signal to cut none.
  if (next) console.log(next);
}
