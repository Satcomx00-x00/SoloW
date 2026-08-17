import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/openapi.js";

/**
 * Emit (or verify) `openapi.json` from the tRPC routers (task TASK-013).
 *   bun run openapi:gen     → write the artifact
 *   bun run openapi:check   → exit 1 if the committed artifact is stale (CI gate)
 *
 * Run via the `stub-server-only` preload so the router graph imports outside an RSC.
 */
const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "openapi.json");
const doc = buildOpenApiDocument();
const json = `${JSON.stringify(doc, null, 2)}\n`;
const pathCount = Object.keys(doc.paths ?? {}).length;

if (process.argv.includes("--check")) {
  const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (current !== json) {
    console.error(
      "openapi.json is stale or missing — run `bun run openapi:gen` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`openapi.json is up to date (${pathCount} paths).`);
} else {
  writeFileSync(outPath, json);
  console.log(`wrote ${outPath} (${pathCount} paths).`);
}
