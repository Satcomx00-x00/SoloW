/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AC-2's "grep-verifiable" half, expressed as a test so it cannot rot (issue #3).
 *
 * The claim is that the status bar contains no hardcoded per-feature visibility branch. The way
 * to keep that true is not to look for `if` statements — it is to check what the file is allowed
 * to import, because a surface that cannot name a feature module cannot branch on one. Every
 * segment, and every reason a segment does or does not appear, lives behind a registration.
 *
 * This asserts over the file the shell actually mounts. An assertion aimed at a second copy of
 * the bar would pass while the shipped one branched — which is precisely what happened while
 * `components/shell/status-bar.tsx` still existed alongside this one.
 */

const SOURCE = readFileSync(join(import.meta.dir, "status-bar.tsx"), "utf8");
const SHELL_DIR = join(import.meta.dir, "..", "..", "shell");

/** Import specifiers, comments stripped first so prose naming a module does not count. */
function importsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g)].map(
    (match) => match[1] as string,
  );
}

describe("the status bar surface", () => {
  it("imports the registry, the boot barrel and nothing feature-shaped", () => {
    expect([...importsOf(SOURCE)].sort()).toEqual([
      "@/hooks/use-surface-layout",
      "@/lib/app-context",
      "@/lib/contribution-boundary",
      "@/lib/contributions",
      "@/lib/contributions-boot",
    ]);
  });

  it("names no contribution id, so it cannot single one out", () => {
    expect(SOURCE).not.toMatch(/status\.[a-z-]+/);
  });

  it("still imports the boot barrel — without it the bar renders correctly and shows nothing", () => {
    expect(importsOf(SOURCE)).toContain("@/lib/contributions-boot");
  });

  it("is the bar the shell mounts, and the only one there is", () => {
    // The registry-driven bar shipped once before while `dashboard-shell` still rendered a
    // hardcoded copy, so every claim above was true of a file the product never loaded.
    const shell = readFileSync(join(SHELL_DIR, "dashboard-shell.tsx"), "utf8");
    expect(shell).toContain('from "@/components/features/status-bar/status-bar"');
    expect(existsSync(join(SHELL_DIR, "status-bar.tsx"))).toBe(false);
  });
});
