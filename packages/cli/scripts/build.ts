/// <reference types="bun-types" />

/**
 * Assemble the publishable `@satcomx00-x00/solow` package.
 *
 * The repo is a Bun workspace monorepo; npm installs a single flat tarball. This bridges the
 * two by producing a `dist/` that carries everything the launcher needs and nothing it does
 * not: a traced standalone web build, the orchestrator and the two database entry points as
 * self-contained bundles, and the migration SQL.
 *
 * Run from CI before `npm publish` (see .github/workflows/publish.yml), or by hand with
 * `bun run --filter '@satcomx00-x00/solow' build`.
 */

import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(CLI, "..", "..");
const DIST = join(CLI, "dist");

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  console.log(`  $ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`\`${cmd.join(" ")}\` exited with ${code}`);
}

/**
 * `bun build --target=bun` inlines every workspace import, so the published tarball carries no
 * `@solow/*` packages and npm never has to resolve them. Bun's own builtins (`bun:sqlite`) stay
 * external by construction — they are provided by the runtime the launcher starts these under.
 */
async function bundle(entry: string, outfile: string) {
  await run(["bun", "build", entry, "--target=bun", "--outfile", outfile], ROOT);
}

/**
 * Rewrite Bun's isolated `node_modules` into the flat one npm ships.
 *
 * **This is what makes the published package runnable at all**, and the bug it fixes was
 * invisible until someone ran it (reported 2026-08-28: "Cannot find package 'next'").
 *
 * Bun installs isolated: every real package lives at `node_modules/.bun/<name>@<version>/
 * node_modules/<name>`, and what makes it *resolvable* is a symlink — `apps/web/node_modules/next`
 * pointing into `.bun`, and, inside each package's own directory, more symlinks to its
 * dependencies. Next's standalone tracer reproduces that shape faithfully.
 *
 * `npm pack` drops every symlink; a published tarball contains none. So the real files shipped
 * and nothing could find them. It worked in the monorepo only by accident — Node walks up from
 * `.next/standalone/...` and finds the repository's own `node_modules` a few levels above, which
 * is exactly the parent a tarball does not have.
 *
 * Dereferencing the copy is not enough: it fixes the two entry symlinks and leaves each package's
 * *siblings* unresolvable (`next` then fails on `styled-jsx` instead). What a tarball needs is
 * the layout npm itself uses — one flat directory of real packages — so that is what this builds:
 * every real package hoisted to `node_modules/<name>`, `.bun` removed, and the now-redundant
 * `apps/web/node_modules` removed with it so resolution walks straight up to the flat set.
 *
 * Safe to flatten because this tree is a *traced* dependency set: every package appears at
 * exactly one version (asserted below — a second version would make hoisting silently pick a
 * winner, which is the one way this could go wrong quietly).
 */
async function flattenNodeModules(webDist: string) {
  const modules = join(webDist, "node_modules");
  const isolated = join(modules, ".bun");
  if (!existsSync(isolated)) return;

  /** Every real (non-symlink) package directory, as `name` → absolute path. */
  const packages = new Map<string, string>();
  const record = async (name: string, path: string) => {
    const existing = packages.get(name);
    if (existing && existing !== path) {
      throw new Error(
        `${name} appears at two versions in the traced tree (${existing} and ${path}) — ` +
          "hoisting them into one flat node_modules would silently pick one. Resolve the " +
          "duplicate before publishing.",
      );
    }
    packages.set(name, path);
  };

  for (const pkgId of await readdir(isolated)) {
    // `.bun/node_modules` is Bun's own hoist directory: symlinks only, no package of its own.
    if (pkgId === "node_modules") continue;
    const inner = join(isolated, pkgId, "node_modules");
    if (!existsSync(inner)) continue;

    for (const entry of await readdir(inner, { withFileTypes: true })) {
      // A symlink here is a cross-link to another package's real directory — that package is
      // recorded when its own `.bun` entry is walked, so following it would only duplicate.
      if (entry.isSymbolicLink()) continue;
      if (entry.name.startsWith("@")) {
        const scope = join(inner, entry.name);
        for (const scoped of await readdir(scope, { withFileTypes: true })) {
          if (scoped.isSymbolicLink()) continue;
          await record(`${entry.name}/${scoped.name}`, join(scope, scoped.name));
        }
        continue;
      }
      await record(entry.name, join(inner, entry.name));
    }
  }

  for (const [name, from] of packages) {
    // `dereference`, because a package's own directory still holds symlinks to its dependencies
    // — the very thing npm would drop. Each target is itself hoisted above, so this duplicates
    // a package's dependency trees into it; that is the cost of a layout npm can actually ship.
    await cp(from, join(modules, name), { recursive: true, dereference: true });
  }

  await rm(isolated, { recursive: true, force: true });
  // Its entries were symlinks into `.bun`, now dangling — and redundant, since every package is
  // resolvable from the flat directory above.
  await rm(join(webDist, "apps", "web", "node_modules"), { recursive: true, force: true });
}

console.log("solow: building package");

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

console.log("\n[1/4] web app (Next.js standalone)");
await run(["bun", "--bun", "run", "build"], join(ROOT, "apps", "web"), {
  SOLOW_PACKAGE_BUILD: "1",
});

const standalone = join(ROOT, "apps", "web", ".next", "standalone");
if (!existsSync(standalone)) {
  throw new Error(
    `expected a standalone build at ${standalone} — is SOLOW_PACKAGE_BUILD wired in next.config.mjs?`,
  );
}
await cp(standalone, join(DIST, "web"), { recursive: true });
await flattenNodeModules(join(DIST, "web"));

// Next deliberately leaves these two out of the traced tree: `static/` is served by the server
// but never imported by it, and `public/` is not code at all. Standalone deployments are
// expected to copy them in, and a build that skips this serves a page with no CSS or JS.
await cp(
  join(ROOT, "apps", "web", ".next", "static"),
  join(DIST, "web", "apps", "web", ".next", "static"),
  { recursive: true },
);
const publicDir = join(ROOT, "apps", "web", "public");
if (existsSync(publicDir)) {
  await cp(publicDir, join(DIST, "web", "apps", "web", "public"), { recursive: true });
}

console.log("\n[2/4] orchestrator");
await bundle(
  join(ROOT, "apps", "orchestrator", "src", "main.ts"),
  join(DIST, "orchestrator", "index.js"),
);

console.log("\n[3/4] database entry points");
await bundle(join(ROOT, "packages", "db", "src", "migrate.ts"), join(DIST, "db", "migrate.js"));
await bundle(join(ROOT, "packages", "db", "src", "seed.ts"), join(DIST, "db", "seed.js"));

console.log("\n[4/4] migrations");
// `migrate.js` resolves this as `../migrations` from its own location, so the layout here is
// load-bearing: dist/db/migrate.js alongside dist/migrations/.
await cp(join(ROOT, "packages", "db", "migrations"), join(DIST, "migrations"), { recursive: true });

/*
 * The tarball has to be able to *resolve* what it ships, not merely contain it.
 *
 * Checked here rather than trusted, because the failure this catches is invisible everywhere
 * else: the files were present, `npm pack --dry-run` listed them, the build printed success, and
 * the package still could not start — the one missing piece was a symlink npm had dropped, and
 * nothing in the pipeline looked for it. `lstat` rather than `existsSync`: a surviving symlink
 * would satisfy "exists" and then be dropped by `npm pack` all over again, which is precisely
 * the bug.
 */
for (const dep of ["next", "react", "react-dom", "styled-jsx"]) {
  const entry = join(DIST, "web", "node_modules", dep);
  const stats = await lstat(entry).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(
      `${entry} is not a real directory (${stats === null ? "missing" : "a symlink"}) — ` +
        "npm pack drops symlinks, so the published package would fail to resolve it at runtime.",
    );
  }
}

console.log(`\nsolow: dist ready at ${DIST}`);
