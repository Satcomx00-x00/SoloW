import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Executor-boundary audit (issue #1, AC-4). Every reach into the execution host — spawning a
 * process, touching the filesystem, shelling out — must go through the `Executor` interface, so
 * a second executor kind (#46 #47 #48) grows one driver instead of a second call site scattered
 * through the app.
 *
 * `apps/orchestrator/src/executor/local.ts` is the one file allowed to call `Bun.spawn`,
 * `Bun.file`/`Bun.write`, or the Bun shell tag (`` $` ``); everything else under `apps/` and
 * `packages/` production code must reach the host through it. Test files, fixtures, and
 * build/dev scripts are exempt — they stand in for the host in a sandbox, or run at build time,
 * never as part of a live Task.
 */

const ROOT = join(import.meta.dir, "..");
const SCAN_DIRS = ["apps", "packages"];

const ALLOWED_FILES = new Set(["apps/orchestrator/src/executor/local.ts"]);

const EXEMPT_PATTERNS: RegExp[] = [
  /\.test\.ts$/,
  /\.spec\.ts$/,
  /\/testing\.ts$/,
  /\/fixtures\//,
  /\/scripts\//,
];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage"]);

const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: "Bun.spawn", pattern: /Bun\.spawn\(/ },
  { name: "Bun.spawnSync", pattern: /Bun\.spawnSync\(/ },
  { name: "Bun.file", pattern: /Bun\.file\(/ },
  { name: "Bun.write", pattern: /Bun\.write\(/ },
  { name: "Bun shell tag ($`...`)", pattern: /\$`/ },
  {
    name: 'Bun shell import (import { $ } from "bun")',
    pattern: /import\s*\{\s*\$\s*\}\s*from\s*"bun"/,
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

const violations: string[] = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file);
    if (ALLOWED_FILES.has(rel)) continue;
    if (EXEMPT_PATTERNS.some((pattern) => pattern.test(rel))) continue;

    const text = readFileSync(file, "utf8");
    for (const rule of RULES) {
      if (rule.pattern.test(text)) {
        violations.push(`${rel}: ${rule.name} outside the local executor implementation`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("executor-boundary audit FAILED — direct host access outside the Executor:\n");
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "\nRoute this through apps/orchestrator/src/executor/local.ts, or — if it genuinely is not " +
      "agent-execution-host code (a test, fixture, or build script) — add a narrowly-scoped " +
      "exemption above with the reason.",
  );
  process.exit(1);
}

console.log("executor-boundary audit OK — no direct host access outside the Executor");
