import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DEFAULT_HARNESS_CATALOG } from "@solow/db";
import { REQUIRED_CONTAINER_UTILITIES } from "./docker.js";

/**
 * `docker/executor/Dockerfile`, the image the guided setup runs Claude in (roadmap B4), read as
 * text: building it takes a daemon and minutes, and what can drift without one is checked here.
 */

const DOCKERFILE = readFileSync(
  join(import.meta.dir, "..", "..", "..", "..", "docker", "executor", "Dockerfile"),
  "utf8",
);

/** Every `ARG NAME=default`, from both stages — they have to agree with each other too. */
function argDefaults(name: string): string[] {
  return [...DOCKERFILE.matchAll(new RegExp(`^ARG ${name}=(\\S+)$`, "gm"))].map((m) => m[1] ?? "");
}

describe("the executor image", () => {
  it("installs the opencode the orchestrator ships and the catalog pins", () => {
    const pkg = createRequire(import.meta.url)("../../package.json") as {
      dependencies: Record<string, string>;
    };
    const shipped = pkg.dependencies["@opencode/cli"];
    const pin = DEFAULT_HARNESS_CATALOG.find((row) => row.key === "opencode")?.minVersion;
    const built = argDefaults("OPENCODE_VERSION");
    expect(built.length).toBeGreaterThan(0);
    // A container running another build than the host would answer the same Task differently.
    for (const version of built) {
      expect(version).toBe(shipped ?? "");
      expect(version).toBe(pin ?? "");
    }
  });

  it("pins Claude Code to one exact release in both stages", () => {
    const built = new Set(argDefaults("CLAUDE_CODE_VERSION"));
    expect(built.size).toBe(1);
    expect([...built][0]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("names the commands the catalog spawns, since the driver spawns them bare", () => {
    for (const row of DEFAULT_HARNESS_CATALOG) {
      expect(DOCKERFILE).toContain(`/harnesses/${row.command}`);
    }
  });

  it("leaves HOME to the driver's tmpfs and runs as nobody privileged", () => {
    // An image that declares HOME wins over the tmpfs (`baseEnv`), and a home that outlives the
    // container is where a harness's credential cache would survive the run.
    expect(DOCKERFILE).not.toMatch(/^ENV\s+HOME\b/m);
    expect(DOCKERFILE).toMatch(/^USER [1-9]\d*:[1-9]\d*$/m);
  });

  it("adds git, the one utility the preflight needs that a slim Debian lacks", () => {
    expect(REQUIRED_CONTAINER_UTILITIES).toContain("git");
    expect(DOCKERFILE).toMatch(/apt-get install [^\n]*\bgit\b/);
  });

  it("adds a kill binary, which the driver execs to stop a harness and the preflight cannot see", () => {
    // `command -v kill` answers with the shell builtin, so an image without the binary passes the
    // preflight and then cannot stop anything.
    expect(DOCKERFILE).toMatch(/apt-get install [^\n]*\bprocps\b/);
  });
});
