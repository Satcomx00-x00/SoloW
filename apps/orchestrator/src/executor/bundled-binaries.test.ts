/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HARNESS_CATALOG } from "@solow/db";
import {
  bundledBinary,
  detectHost,
  type HostShape,
  isNativeExecutable,
  platformPackages,
  withBundledCommand,
} from "./bundled-binaries.js";

/**
 * opencode, installed by SoloW itself (user decision, 2026-09-28).
 *
 * The part that is easy to get wrong is the part `@opencode/cli`'s own postinstall usually does:
 * choosing which of several platform builds the package manager fetched is the one that runs
 * here, without running that postinstall (a current npm blocks it, Bun skips it untrusted).
 */

const glibcX64: HostShape = { platform: "linux", arch: "x64", musl: false, avx2: true };

describe("which platform build is tried first", () => {
  const cases: Array<[string, HostShape, string[]]> = [
    [
      "glibc x64 with AVX2",
      glibcX64,
      [
        "@opencode/cli-linux-x64",
        "@opencode/cli-linux-x64-baseline",
        "@opencode/cli-linux-x64-musl",
        "@opencode/cli-linux-x64-baseline-musl",
      ],
    ],
    [
      "glibc x64 without AVX2 prefers the baseline build",
      { ...glibcX64, avx2: false },
      [
        "@opencode/cli-linux-x64-baseline",
        "@opencode/cli-linux-x64",
        "@opencode/cli-linux-x64-baseline-musl",
        "@opencode/cli-linux-x64-musl",
      ],
    ],
    [
      "musl x64 (Alpine) prefers the musl builds",
      { ...glibcX64, musl: true },
      [
        "@opencode/cli-linux-x64-musl",
        "@opencode/cli-linux-x64-baseline-musl",
        "@opencode/cli-linux-x64",
        "@opencode/cli-linux-x64-baseline",
      ],
    ],
    [
      "arm64 Linux has no baseline split",
      { platform: "linux", arch: "arm64", musl: false, avx2: false },
      ["@opencode/cli-linux-arm64", "@opencode/cli-linux-arm64-musl"],
    ],
    [
      "macOS arm64",
      { platform: "darwin", arch: "arm64", musl: false, avx2: false },
      ["@opencode/cli-darwin-arm64"],
    ],
    [
      "Windows is spelled `windows`, as the packages are",
      { platform: "win32", arch: "x64", musl: false, avx2: true },
      ["@opencode/cli-windows-x64", "@opencode/cli-windows-x64-baseline"],
    ],
  ];
  for (const [name, host, expected] of cases) {
    it(name, () => {
      expect(platformPackages("@opencode/cli", host)).toEqual(expected);
    });
  }
});

describe("telling a binary from its placeholder", () => {
  it("rejects the shell script `@opencode/cli` ships where the executable goes", () => {
    const placeholder = join(
      createRequire(import.meta.url).resolve("@opencode/cli/package.json"),
      "..",
      "bin",
      "opencode.exe",
    );
    // Only while the postinstall has not replaced it — which is the install this module exists
    // for. A trusted install that ran it holds the real binary there, and that is not this case.
    const text = readFileSync(placeholder, "utf8").slice(0, 40);
    if (text.startsWith("echo")) expect(isNativeExecutable(placeholder)).toBe(false);
    else expect(isNativeExecutable(placeholder)).toBe(true);
  });

  it("rejects text and missing files, accepts an ELF header", async () => {
    const dir = await mkdtemp(join(tmpdir(), "solow-bundled-"));
    try {
      await writeFile(join(dir, "script"), 'echo "not a binary"\n');
      await writeFile(join(dir, "elf"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]));
      expect(isNativeExecutable(join(dir, "script"))).toBe(false);
      expect(isNativeExecutable(join(dir, "missing"))).toBe(false);
      expect(isNativeExecutable(join(dir, "elf"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolving the bundled command", () => {
  it("answers only for commands this build installs", () => {
    expect(bundledBinary("claude")).toBeNull();
    expect(bundledBinary("opencode-nightly")).toBeNull();
  });

  it("says nothing is bundled when the package itself is not installed", () => {
    const missing = () => {
      throw new Error("Cannot find module");
    };
    expect(bundledBinary("opencode", glibcX64, missing)).toBeNull();
  });

  it("swaps a bare `opencode` for the bundled path and leaves every other argv alone", () => {
    const path = bundledBinary("opencode");
    const swapped = withBundledCommand(["opencode", "acp"]);
    expect(swapped).toEqual(path ? [path, "acp"] : ["opencode", "acp"]);
    expect(withBundledCommand(["claude", "-p"])).toEqual(["claude", "-p"]);
    // An absolute path in a catalog row means that binary; it is not ours to reinterpret.
    expect(withBundledCommand(["/opt/opencode/bin/opencode", "acp"])).toEqual([
      "/opt/opencode/bin/opencode",
      "acp",
    ]);
    expect(withBundledCommand([])).toEqual([]);
  });

  const installed = bundledBinary("opencode", detectHost());
  const it_ = installed ? it : it.skip;

  it_("finds a runnable build on this host, not the placeholder", () => {
    expect(installed).not.toBeNull();
    expect(isNativeExecutable(installed as string)).toBe(true);
    expect(installed).not.toContain(join("@opencode", "cli", "bin"));
  });

  it_("runs the exact build the catalog pins — the dependency and the pin move together", () => {
    const version = spawnSync(installed as string, ["--version"], {
      encoding: "utf8",
    })
      // OpenCode 2 prints `opencode v2.0.22`; 1.x printed the bare number.
      .stdout.trim()
      .replace(/^opencode v/, "");
    const pkg = createRequire(import.meta.url)("@opencode/cli/package.json") as { version: string };
    const pin = DEFAULT_HARNESS_CATALOG.find((row) => row.key === "opencode")?.minVersion;
    expect(version).toBe(pkg.version);
    // Bumping `@opencode/cli` without the seeded minimum (or the reverse) leaves a fresh
    // Workspace pinned to a build it does not ship.
    expect(pin).toBe(pkg.version);
  });
});
