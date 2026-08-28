/// <reference types="bun-types" />

/**
 * Repackage the Inngest Dev Server binary as per-platform npm packages.
 *
 * **Why this exists.** `inngest-cli` publishes a placeholder and downloads the real binary from
 * `cli.inngest.com` (falling back to GitHub) in a postinstall hook. That makes it unusable in two
 * situations SoloW has to work in: an npm that blocks install scripts (npm 12 does, by default),
 * and an airgapped or npm-only environment, where the download simply cannot happen. Inngest
 * publishes no per-platform npm packages, and neither does anyone else — the binary is not
 * obtainable from the registry at all (checked 2026-08-28).
 *
 * So SoloW publishes them. Each package carries one platform's binary *inside the tarball*, is
 * constrained by `os`/`cpu`, and is declared an `optionalDependency` of the CLI — so npm installs
 * exactly one, from the registry, with no script and no network beyond npm itself. This is the
 * same mechanism Bun already uses for `@oven/bun-<platform>`, which is why Bun works airgapped
 * and Inngest did not.
 *
 * **Licensing.** The binary is Inngest's, under the Server Side Public License (with their
 * Apache-2.0-future grant). SSPL permits conveying verbatim copies, and SoloW only ever invokes
 * it as a separate process — no linking, no modification. The upstream LICENSE.md is copied into
 * every package unchanged, and each package's README says plainly whose software it is. The
 * decision to redistribute was taken deliberately by the repository owner (2026-08-28).
 *
 * Run: `bun run packages/cli/scripts/build-inngest-packages.ts [--publish]`
 * Without `--publish` it builds the package directories and stops, which is what CI and a
 * dry run want.
 */

import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(CLI, "vendor-inngest");

/** The scope these are published under — the same one the CLI itself uses. */
const SCOPE = "@satcomx00-x00";

/**
 * One published package per platform npm can distinguish.
 *
 * `os`/`cpu` are what make this work: npm evaluates them against the host and installs only the
 * matching package, skipping the rest without downloading them. `artifact` follows Inngest's own
 * release naming (`archMap`/`platformMap` in their postinstall).
 */
const TARGETS = [
  { os: "linux", cpu: "x64", artifact: "linux_amd64", ext: ".tar.gz" },
  { os: "linux", cpu: "arm64", artifact: "linux_arm64", ext: ".tar.gz" },
  { os: "darwin", cpu: "x64", artifact: "darwin_amd64", ext: ".tar.gz" },
  { os: "darwin", cpu: "arm64", artifact: "darwin_arm64", ext: ".tar.gz" },
  { os: "win32", cpu: "x64", artifact: "windows_amd64", ext: ".zip" },
  { os: "win32", cpu: "arm64", artifact: "windows_arm64", ext: ".zip" },
] as const;

/** `win32` is Node's name for it; the package name reads better as `windows`. */
const PACKAGE_OS: Record<string, string> = { linux: "linux", darwin: "darwin", win32: "windows" };

export function packageNameFor(target: { os: string; cpu: string }): string {
  return `${SCOPE}/solow-inngest-${PACKAGE_OS[target.os] ?? target.os}-${target.cpu}`;
}

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`\`${cmd.join(" ")}\` exited with ${code}`);
}

/** The version of `inngest-cli` the repo depends on — the binary's version, and each package's. */
async function inngestVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(CLI, "package.json"), "utf8"));
  const range: string = manifest.dependencies?.["inngest-cli"] ?? "";
  const pinned = range.replace(/^[\^~]/, "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
    throw new Error(`cannot read a concrete inngest-cli version from "${range}"`);
  }
  return pinned;
}

/**
 * `curl` rather than `fetch` + `Bun.write`: the latter hung indefinitely on these artifacts
 * (nothing on disk after eleven minutes, while `curl` pulls the same URL at 25 MB/s). This
 * script already shells out for `tar` and `unzip`, so one more host tool costs nothing and the
 * failure mode — a non-zero exit with curl's own message — is easier to read than a stall.
 */
async function download(url: string, to: string) {
  await run(["curl", "-fsSL", "--retry", "3", "-o", to, url], OUT);
}

const publish = process.argv.includes("--publish");
const version = await inngestVersion();

console.log(`inngest vendor packages: version ${version}${publish ? " (publishing)" : ""}`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const target of TARGETS) {
  const name = packageNameFor(target);
  const dir = join(OUT, `${PACKAGE_OS[target.os]}-${target.cpu}`);
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });

  const archive = join(OUT, `inngest_${version}_${target.artifact}${target.ext}`);
  const url = `https://cli.inngest.com/artifact/v${version}/inngest_${version}_${target.artifact}${target.ext}`;
  console.log(`  ${name}`);
  await download(url, archive);

  /*
   * Extracted with the host's own tools rather than a library: one fewer dependency in a script
   * whose only job is to move a binary from one archive into one directory.
   *
   * Both the binary and upstream's `LICENSE.md` come out of the release archive — the licence is
   * *not* in the `inngest-cli` npm tarball, so reading it from `node_modules` would only work on
   * a machine where that package's postinstall had already run. Taking it from the same archive
   * as the binary means the licence always matches the binary it ships beside.
   */
  if (target.ext === ".zip") {
    await run(["unzip", "-o", "-q", archive, "-d", binDir], OUT);
  } else {
    await run(["tar", "xzf", archive, "-C", binDir], OUT);
  }
  const extractedLicense = join(binDir, "LICENSE.md");
  if (!existsSync(extractedLicense)) {
    throw new Error(`${name}: upstream's LICENSE.md was not in ${archive}`);
  }
  const license = await readFile(extractedLicense, "utf8");
  await rm(extractedLicense, { force: true });

  const binary = join(binDir, target.os === "win32" ? "inngest.exe" : "inngest");
  if (!existsSync(binary)) throw new Error(`${name}: no binary at ${binary} after extraction`);
  // The archive's mode does not always survive; the launcher spawns this directly.
  await chmod(binary, 0o755);

  await writeFile(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name,
        version,
        description:
          `The Inngest Dev Server binary for ${PACKAGE_OS[target.os]}-${target.cpu}, ` +
          "repackaged so it installs from npm without a postinstall download.",
        license: "SEE LICENSE IN LICENSE.md",
        os: [target.os],
        cpu: [target.cpu],
        files: ["bin/", "LICENSE.md", "README.md"],
        repository: {
          type: "git",
          url: "git+https://github.com/Satcomx00-x00/SoloW.git",
          directory: "packages/cli",
        },
        publishConfig: { access: "public" },
      },
      null,
      2,
    )}\n`,
  );

  await writeFile(join(dir, "LICENSE.md"), license);
  await writeFile(
    join(dir, "README.md"),
    `# ${name}\n\n` +
      `The [Inngest](https://www.inngest.com) Dev Server binary for ` +
      `\`${PACKAGE_OS[target.os]}-${target.cpu}\`, version ${version}.\n\n` +
      "**This is not SoloW's software.** The binary is Inngest's, redistributed unmodified under " +
      "the Server Side Public License (see `LICENSE.md`) so that it can be installed from npm " +
      "alone — `inngest-cli` otherwise downloads it in a postinstall hook, which fails on an npm " +
      "that blocks install scripts and in airgapped environments.\n\n" +
      "It exists to be an optional dependency of " +
      `[\`${SCOPE}/solow\`](https://www.npmjs.com/package/${SCOPE}/solow); there is no reason to ` +
      "depend on it directly. For the Inngest CLI itself, use " +
      "[`inngest-cli`](https://www.npmjs.com/package/inngest-cli).\n",
  );

  await rm(archive, { force: true });

  if (!publish) continue;

  /*
   * These are versioned on Inngest, not on SoloW: `@…/solow-inngest-linux-x64@1.44.0` holds
   * Inngest 1.44.0's binary and never changes again. So every SoloW release would try to
   * republish a version that already exists, which npm refuses — and a release must not fail for
   * having nothing to do. Published once per Inngest version, skipped forever after.
   */
  const already = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (already.exitCode === 0) {
    console.log(`    already on npm — skipped`);
    continue;
  }
  await run(["npm", "publish", "--access", "public"], dir);
}

console.log(
  publish
    ? "\ninngest vendor packages: published"
    : `\ninngest vendor packages: built in ${OUT} (pass --publish to publish)`,
);
