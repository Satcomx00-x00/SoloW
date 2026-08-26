import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Provider-branching audit (issue #122 AC-4, Decision 0016, Decision 0018).
 *
 * The rule this enforces is one sentence: **callers ask for a capability, never for a provider.**
 *
 * It exists because the failure is so easy and so quiet. GitHub Projects v2 can express every
 * field type; GitLab cannot. The shortest way to ship a project table is one `if (provider ===
 * "github")`, and every one after it is shorter still — until GitLab is a degraded GitHub and
 * the capability registry is decoration. F21 removed exactly eight such branches; this is what
 * keeps the ninth from arriving.
 *
 * What is allowed: a *driver* naming its own provider (that is what a driver is), a manifest
 * declaring an id, and a test asserting on one. What is not: product code deciding behaviour
 * from a provider's identity instead of from what it declared it can do.
 */

const ROOT = join(import.meta.dir, "..");

/** Where product code lives. A driver's own package is where naming a provider is the job. */
const SCAN_DIRS = ["apps/web/src", "apps/orchestrator/src", "packages/core/src"];

const EXEMPT_PATTERNS: RegExp[] = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /\/fixtures\//];

const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", "coverage"]);

/** The known provider ids, as a comparison against any of them is the smell. */
const PROVIDERS = ["github", "gitlab", "gitea"];

const RULES: Array<{ name: string; pattern: RegExp }> = PROVIDERS.flatMap((id) => [
  {
    name: `equality against "${id}"`,
    pattern: new RegExp(`(===|!==|==\\s|!=\\s)\\s*["'\`]${id}["'\`]`),
  },
  {
    name: `switch case on "${id}"`,
    pattern: new RegExp(`case\\s+["'\`]${id}["'\`]\\s*:`),
  },
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const violations: string[] = [];

for (const dir of SCAN_DIRS) {
  const base = join(ROOT, dir);
  try {
    statSync(base);
  } catch {
    continue;
  }
  for (const file of walk(base)) {
    const rel = relative(ROOT, file);
    if (EXEMPT_PATTERNS.some((p) => p.test(rel))) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      // An explicit opt-out, for the rare place a provider's identity genuinely is the subject.
      // It has to say why, in the same line, so the exception is reviewable.
      if (line.includes("provider-branch-ok:")) return;
      for (const rule of RULES) {
        if (rule.pattern.test(line)) {
          violations.push(`${rel}:${index + 1}  ${rule.name}\n    ${line.trim()}`);
        }
      }
    });
  }
}

if (violations.length > 0) {
  console.error("provider-branching audit FAILED — product code deciding from a provider's id:\n");
  for (const v of violations) console.error(`  ${v}\n`);
  console.error(
    "Ask the provider's manifest what it can do (capabilities, projectFields) instead.\n" +
      "If the identity genuinely is the subject, add `provider-branch-ok: <reason>` on the line.",
  );
  process.exit(1);
}

console.log("provider-branching audit OK — no product code branches on a provider's identity");
