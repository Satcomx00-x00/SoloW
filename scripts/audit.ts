/// <reference types="bun-types" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Dependency-audit gate (task TASK-029, constitution Security constraint).
 *
 * The project's severity threshold: no `high` or `critical` advisory may reach a runtime
 * dependency. Advisories that can only affect build or test tooling are listed in
 * `scripts/audit-allowlist.txt` together with the reason they are unreachable and what would
 * make them reachable again; anything high or critical outside that list fails the build.
 */

interface Advisory {
  id: number;
  severity: string;
  title: string;
  url: string;
}

const ROOT = join(import.meta.dir, "..");
const ALLOWLIST = join(ROOT, "scripts", "audit-allowlist.txt");

function allowlisted(): Set<number> {
  return new Set(
    readFileSync(ALLOWLIST, "utf8")
      .split("\n")
      .map((line) => line.split("#")[0]?.trim() ?? "")
      .filter(Boolean)
      .map(Number),
  );
}

const proc = Bun.spawnSync(["bun", "audit", "--json"], { cwd: ROOT });
const raw = proc.stdout.toString().trim();
if (!raw) {
  console.error("dependency audit FAILED: `bun audit --json` produced no report");
  console.error(proc.stderr.toString());
  process.exit(1);
}

const report = JSON.parse(raw) as Record<string, Advisory[]>;
const allow = allowlisted();
const blocking: string[] = [];
let allowed = 0;

for (const [pkg, advisories] of Object.entries(report)) {
  for (const advisory of advisories) {
    if (advisory.severity !== "high" && advisory.severity !== "critical") continue;
    if (allow.has(advisory.id)) {
      allowed += 1;
      continue;
    }
    blocking.push(`${advisory.severity}\t${pkg}\t${advisory.id}\t${advisory.title}`);
  }
}

if (blocking.length > 0) {
  console.error("dependency audit FAILED — high/critical advisories above the threshold:\n");
  for (const line of blocking) console.error(`  ${line}`);
  console.error(
    `\nFix the dependency, or add the advisory id to ${ALLOWLIST} with the reason it cannot ` +
      "reach a runtime surface.",
  );
  process.exit(1);
}

console.log(`dependency audit OK (${allowed} high/critical allowlisted as build/test-only)`);
