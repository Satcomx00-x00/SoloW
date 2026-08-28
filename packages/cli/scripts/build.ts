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
import { cp, mkdir, rm } from "node:fs/promises";
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

console.log(`\nsolow: dist ready at ${DIST}`);
