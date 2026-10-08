/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { bunTestArgs, ISOLATED, MAX_FILES_PER_BATCH, planBatches } from "./test-batches.ts";

const ROOT = join(import.meta.dir, "..");
const HEAVY = "src/components/features/task/task-workspace.test.tsx";

describe("the web test batches", () => {
  it("groups by directory, in even chunks no bigger than the cap", () => {
    const files = Array.from(
      { length: MAX_FILES_PER_BATCH + 1 },
      (_, i) => `src/lib/f${i}.test.ts`,
    );
    const batches = planBatches("apps/web", [...files, "src/app/page.test.tsx"]);
    expect(batches.map((b) => [b.name, b.files.length])).toEqual([
      ["src/app", 1],
      ["src/lib (1/2)", 6],
      ["src/lib (2/2)", 5],
    ]);
    // Every file runs exactly once, as a path bun cannot mistake for a name filter.
    const planned = batches.flatMap((b) => b.files);
    expect(new Set(planned).size).toBe(files.length + 1);
    expect(planned.every((f) => f.startsWith("./"))).toBe(true);
  });

  it("runs an isolated file alone, with its own budget and test timeout", () => {
    const batches = planBatches("apps/web", [HEAVY, "src/components/features/task/a.test.tsx"]);
    const alone = batches.find((b) => b.name === HEAVY);
    expect(alone?.files).toEqual([`./${HEAVY}`]);
    expect(bunTestArgs(alone as NonNullable<typeof alone>)).toEqual([
      "bun",
      "test",
      `./${HEAVY}`,
      "--timeout",
      String(ISOLATED[`apps/web/${HEAVY}`]?.testTimeoutMs),
    ]);
    expect(batches.find((b) => b.name === "src/components/features/task")?.files).toEqual([
      "./src/components/features/task/a.test.tsx",
    ]);
  });

  it("names only files that exist, so the list cannot rot", () => {
    for (const path of Object.keys(ISOLATED)) expect(existsSync(join(ROOT, path))).toBe(true);
  });
});
