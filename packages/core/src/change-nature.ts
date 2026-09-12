/**
 * What kind of file a changed path is, for the reviewer's sake (review analysis, point 2).
 *
 * A thirty-file change is not thirty equal things. Some of it is generated — a drizzle snapshot,
 * a GraphQL artefact, a lockfile — and reading it line by line is time spent on the tool's
 * output rather than the harness's; some of it is the migration, which is the one file a
 * reviewer must read first because it is the one that cannot be taken back. One rule, shared by
 * the orchestrator (which orders and bounds the capture by it) and the web app (which groups,
 * folds and counts by it), so what the panel calls generated is what the capture folded.
 *
 * Path-based on purpose: it has to be answered before the content is read, from a file list
 * alone, and the conventions it names are the ones every toolchain writes down in its paths.
 * A miss costs a file its fold, never its place in the list.
 */

/** Dependency lockfiles, by basename — churn that is rarely reviewed line by line. */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "flake.lock",
]);

const GENERATED_SEGMENTS = [
  "/generated/",
  "/__generated__/",
  "/drizzle/meta/",
  "/migrations/meta/",
  "/dist/",
  "/build/",
  "/.next/",
  "/coverage/",
  "/__snapshots__/",
  "/node_modules/",
];
const GENERATED_SUFFIXES = [
  "_journal.json",
  ".snapshot.json",
  "_snapshot.json",
  ".snap",
  ".min.js",
  ".min.css",
  ".gen.ts",
  ".generated.ts",
  ".g.dart",
  ".pb.go",
  "openapi.json",
  "persisted-documents.json",
  ".map",
];

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** True for a file no person wrote: a tool's output, folded away and read last. */
export function isGeneratedPath(path: string): boolean {
  const p = `/${path}`;
  if (LOCKFILE_NAMES.has(basename(path))) return true;
  if (GENERATED_SEGMENTS.some((segment) => p.includes(segment))) return true;
  return GENERATED_SUFFIXES.some((suffix) => p.endsWith(suffix));
}

/**
 * The order a person reads a change in: what cannot be undone first, what proves it last.
 *
 * Migration → schema → contract → data access → domain → API surface → UI → copy → tests →
 * docs → config → generated. Not alphabetical, and not the harness's order of writing — the
 * order of consequence, which is the one a reviewer's attention should follow.
 */
export const READING_ORDER = [
  "migration",
  "schema",
  "contract",
  "data",
  "domain",
  "api",
  "ui",
  "copy",
  "test",
  "docs",
  "config",
  "generated",
] as const;
export type ReadingRole = (typeof READING_ORDER)[number];

const TEST_PATTERN =
  /(^|\/)(test|tests|spec|specs|__tests__|e2e)\/|\.(test|spec|e2e)\.[jt]sx?$|_test\.(go|py)$|test_[^/]*\.py$/;
const UI_EXTENSIONS = /\.(tsx|jsx|vue|svelte|css|scss|html)$/;

/** Which role a path plays in a change. */
export function readingRoleOf(path: string): ReadingRole {
  const p = `/${path.toLowerCase()}`;
  if (isGeneratedPath(path)) return "generated";
  if (TEST_PATTERN.test(p)) return "test";
  if (/\/migrations?\/|\/drizzle\/[^/]*\.sql$|migration/.test(p) || p.endsWith(".sql"))
    return "migration";
  // The wire contract before the storage schema: a `.graphql` SDL under `schema/` is a contract.
  if (/\/contracts?\/|\/types?\/|\.graphql$|\.proto$|\/dto/.test(p)) return "contract";
  if (/\/schema[s]?(\/|\.[jt]s$)|\.prisma$|\/models?\//.test(p)) return "schema";
  if (/\/dal\/|\/sql|\/repositor(y|ies)\/|\/queries\/|\/db\//.test(p)) return "data";
  // Never a bare `/api/`: it is the name of an app as often as of a layer (`apps/api/src/services`).
  if (
    /\/resolvers?\/|\/routers?\/|\/routes\/|\/controllers?\/|\/handlers?\/|\/endpoints?\//.test(p)
  )
    return "api";
  if (/\/messages\/|\/locales?\/|\/i18n\/|\/translations?\//.test(p)) return "copy";
  if (/\/docs?\/|\.mdx?$|readme|changelog/.test(p)) return "docs";
  if (UI_EXTENSIONS.test(p) || /\/components?\/|\/views?\/|\/pages?\/|\/app\//.test(p)) return "ui";
  if (
    /(^|\/)(package\.json|tsconfig[^/]*\.json|biome\.json|\.[^/]*rc(\.[a-z]+)?|[^/]*\.config\.[jt]s|[^/]*\.ya?ml|makefile|dockerfile)$/.test(
      p,
    )
  )
    return "config";
  return "domain";
}

/** The rank the role sorts by; lower reads first. */
export function readingRank(path: string): number {
  return READING_ORDER.indexOf(readingRoleOf(path));
}

/** Paths in reading order — stable within a role, so two services keep their given order. */
export function orderForReading<T extends { path: string }>(files: readonly T[]): T[] {
  return files
    .map((file, index) => ({ file, index, rank: readingRank(file.path) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.file);
}
