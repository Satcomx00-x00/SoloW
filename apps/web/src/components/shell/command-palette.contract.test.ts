/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AC-2's "grep-verifiable" half for the palette (issue #3), expressed as a test so it cannot rot.
 *
 * The palette may know about search — that is what it is — but it may not know about any one
 * command. The check is what the file imports, because a surface that cannot name a feature's
 * module or its destination list cannot branch on either.
 */

const SOURCE = readFileSync(join(import.meta.dir, "command-palette.tsx"), "utf8");

/** Import specifiers, comments stripped first so prose naming a module does not count. */
function importsOf(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/g)].map(
    (match) => match[1] as string,
  );
}

describe("the command palette surface", () => {
  it("resolves its entries from the registry instead of holding a list", () => {
    expect(importsOf(SOURCE)).toContain("@/lib/contributions");
    expect(SOURCE).toContain("commandRegistry.resolve(");
  });

  it("still imports the boot barrel — without it the palette works and offers nothing", () => {
    expect(importsOf(SOURCE)).toContain("@/lib/contributions-boot");
  });

  it("no longer reaches for the destination list it used to render itself", () => {
    expect(importsOf(SOURCE)).not.toContain("@/lib/navigation");
    expect(SOURCE).not.toContain("SECTIONS");
  });

  it("names no contribution id, so it cannot single one out", () => {
    expect(SOURCE).not.toMatch(/(settings|goto|task)\.[a-z-]+"/);
  });
});
