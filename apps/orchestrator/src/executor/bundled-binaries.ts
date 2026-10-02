import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Harness binaries SoloW installs itself, as npm dependencies, rather than expecting on PATH.
 *
 * opencode is the first (user decision, 2026-09-28; OpenCode 2 since 2026-10-02): "the program must install opencode using
 * npm/bun". It is an exact dependency of the orchestrator here and of `@satcomx00-x00/solow` for
 * the published launcher, so the build that runs is the build the catalog pins
 * (`harness-catalog-defaults.ts`, `minVersion`) — not whatever an operator happened to have
 * installed, and not a second install step anyone has to remember.
 *
 * **Why not `@opencode/cli/bin/opencode.exe`.** That path is a shell placeholder until the
 * package's postinstall copies the real executable over it, and install scripts are exactly what
 * a current npm blocks by default and Bun skips for untrusted packages. The postinstall does not
 * download anything, though: the executable already sits inside a per-platform optional
 * dependency (`@opencode/cli-linux-x64`, …) that the package manager fetched from the registry like
 * any other package. So this reads it from there, the way `packages/cli` reads Bun from
 * `@oven/bun-*`, and never runs a script — the postinstall's own fallback is an `npm install`
 * over the network, which a spawn must not do.
 *
 * Which variant: the same order the postinstall uses, because the package manager installs
 * several for one host (Bun fetched all four linux-x64 builds here) and the wrong one does not
 * run — a musl build on glibc, or the AVX2 build on a CPU without it.
 *
 * Local executor only. A container is a different machine with its own libc and PATH, so the
 * Docker executor keeps spawning the bare command and its image has to carry the harness.
 */

/**
 * A bare command name this build can supply: the npm package that supplies it, the prefix its
 * per-platform builds are published under, and the executable's name inside their `bin/`.
 *
 * OpenCode 2 moved from `opencode-ai` + `opencode-<os>-<arch>` to `@opencode/cli` +
 * `@opencode/cli-<os>-<arch>`; the variant suffixes and the `bin/opencode` layout are unchanged.
 */
const BUNDLED: Readonly<Record<string, { pkg: string; platformPrefix: string; binary: string }>> = {
  opencode: { pkg: "@opencode/cli", platformPrefix: "@opencode/cli", binary: "opencode" },
};

type Resolve = (id: string) => string;

export interface HostShape {
  platform: NodeJS.Platform;
  arch: string;
  /** glibc or musl, on Linux; irrelevant elsewhere. */
  musl: boolean;
  /** Whether an x64 CPU has AVX2 — the non-baseline builds need it. */
  avx2: boolean;
}

/** The platform packages to look in, best first — `postinstall.mjs`'s `packageNames()`. */
export function platformPackages(prefix: string, host: HostShape): string[] {
  const os = host.platform === "win32" ? "windows" : host.platform;
  const base = `${prefix}-${os}-${host.arch}`;
  const baseline = host.arch === "x64" && !host.avx2;
  if (host.platform === "linux") {
    if (host.musl) {
      if (host.arch === "x64") {
        return baseline
          ? [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          : [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`];
      }
      return [`${base}-musl`, base];
    }
    if (host.arch === "x64") {
      return baseline
        ? [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        : [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`];
    }
    return [base, `${base}-musl`];
  }
  if (host.arch === "x64")
    return baseline ? [`${base}-baseline`, base] : [base, `${base}-baseline`];
  return [base];
}

/**
 * What this machine is, read from files rather than by running `ldd` — spawning is the local
 * executor's business, and this module is consulted from inside its `spawn`.
 */
export function detectHost(): HostShape {
  const { platform, arch } = process;
  let musl = false;
  let avx2 = false;
  if (platform === "linux") {
    // A glibc loader present means glibc, whatever else is lying around; a musl loader with no
    // glibc one (Alpine) means musl.
    const glibc = ["/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-aarch64.so.1"].some(existsSync);
    musl =
      !glibc &&
      (existsSync("/etc/alpine-release") ||
        [`/lib/ld-musl-${arch === "arm64" ? "aarch64" : "x86_64"}.so.1`].some(existsSync));
    if (arch === "x64") {
      try {
        avx2 = /(^|\s)avx2(\s|$)/i.test(readFileSync("/proc/cpuinfo", "utf8"));
      } catch {
        avx2 = false;
      }
    }
  }
  // macOS and Windows have no file to read for it, so this assumes AVX2 — true of every x64 Mac
  // and PC from the last decade. A pre-AVX2 x64 machine there would get a build that cannot run;
  // pointing its catalog row at an absolute path is the way out, since only bare names are swapped.
  if (platform !== "linux" && arch === "x64") avx2 = true;
  return { platform, arch, musl, avx2 };
}

/**
 * A real executable, not the text placeholder its package ships in its place: ELF, Mach-O or PE
 * by magic number, exactly as `packages/cli/bin/solow.mjs` tells them apart.
 */
export function isNativeExecutable(path: string): boolean {
  let handle: number | undefined;
  try {
    handle = openSync(path, "r");
    const head = Buffer.alloc(4);
    if (readSync(handle, head, 0, 4, 0) < 4) return false;
    const magic = head.readUInt32BE(0);
    return (
      magic === 0x7f454c46 || // ELF
      magic === 0xfeedface ||
      magic === 0xcefaedfe ||
      magic === 0xfeedfacf ||
      magic === 0xcffaedfe ||
      magic === 0xcafebabe || // Mach-O, every width and the universal wrapper
      head.readUInt16BE(0) === 0x4d5a // PE ("MZ")
    );
  } catch {
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/**
 * The absolute path of the bundled executable for `command`, or null when this build bundles no
 * such command or it is not installed for this platform.
 *
 * Resolved *through* the package that depends on the platform builds, not from this file: under
 * Bun's isolated linker `@opencode/cli-linux-x64` is a dependency of `@opencode/cli` and nothing else can
 * see it, and in the published launcher's flat `node_modules` resolving through the parent finds
 * the same hoisted copy.
 */
export function bundledBinary(
  command: string,
  host: HostShape = detectHost(),
  resolve: Resolve = createRequire(import.meta.url).resolve,
): string | null {
  const entry = BUNDLED[command];
  if (!entry) return null;
  let pkgJson: string;
  try {
    pkgJson = resolve(`${entry.pkg}/package.json`);
  } catch {
    return null;
  }
  // The postinstall ran after all (a trusted install): its copy is the one it verified.
  const copied = join(dirname(pkgJson), "bin", `${entry.binary}.exe`);
  if (isNativeExecutable(copied)) return copied;

  const fromPkg = (id: string) => createRequire(pkgJson).resolve(id);
  const file = host.platform === "win32" ? `${entry.binary}.exe` : entry.binary;
  for (const name of platformPackages(entry.platformPrefix, host)) {
    try {
      const candidate = join(dirname(fromPkg(`${name}/package.json`)), "bin", file);
      if (isNativeExecutable(candidate)) return candidate;
    } catch {
      // not installed for this host — the next candidate
    }
  }
  return null;
}

const cache = new Map<string, string | null>();

/**
 * `argv` with a bundled command swapped for its absolute path; anything else untouched.
 *
 * Only a *bare* name is swapped. A catalog row that says `/opt/opencode/bin/opencode` means that
 * binary, and one that says `opencode-nightly` is not ours to reinterpret. When the bundled copy
 * is missing — optional dependencies skipped, or no build for this platform — the bare name
 * goes through unchanged and the operator's PATH answers, which is how it worked before.
 */
export function withBundledCommand(argv: readonly string[]): string[] {
  const [command, ...rest] = argv;
  if (command === undefined || !Object.hasOwn(BUNDLED, command)) return [...argv];
  if (!cache.has(command)) cache.set(command, bundledBinary(command));
  const path = cache.get(command);
  return path ? [path, ...rest] : [...argv];
}
