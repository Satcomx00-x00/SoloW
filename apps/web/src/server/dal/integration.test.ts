import { describe, it } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * `integration.regression.ts` needs real network I/O and can't run under this workspace's
 * default `bun test` (happy-dom, preloaded globally for React component tests, cannot parse
 * Bun.serve's responses — see that file's header comment). Run it in a separate `bun test`
 * process with a bunfig that skips the happy-dom preload, and surface its result here so it's
 * still part of the normal `bun test` / `make verify` run.
 */
describe("integration DAL — GitLab iid collision regression (isolated subprocess)", () => {
  it("passes without happy-dom's fetch polyfill in the way", () => {
    const webRoot = path.resolve(import.meta.dir, "../../..");
    const result = spawnSync(
      "bun",
      ["--config=./bunfig.test-no-dom.toml", "test", "./src/server/dal/integration.regression.ts"],
      { cwd: webRoot, encoding: "utf8" },
    );

    if (result.status !== 0) {
      throw new Error(
        `integration.regression.ts failed (exit ${String(result.status)}):\n${result.stdout}\n${result.stderr}`,
      );
    }
  });
});
