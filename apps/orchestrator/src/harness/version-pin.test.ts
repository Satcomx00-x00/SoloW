/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReadableVersion } from "@solow/acp";
import { harnessVersionSchema } from "@solow/contracts";
import { DEFAULT_HARNESS_CATALOG } from "@solow/db";
import { bundledBinary } from "../executor/bundled-binaries.js";
import { createLocalExecutor } from "../executor/local.js";
import { clientDirectives } from "./client-directives.js";
import { probeHarness } from "./probe.js";

/**
 * The catalog's version pin, where its two halves meet.
 *
 * The grammar of a version is stated twice — `@solow/contracts` validates what an Owner types,
 * `@solow/acp` reads what a harness reports — because the ACP package depends on nothing but zod.
 * This is the one place that imports both, so it holds them to the same answers: a pin the form
 * accepted and the client could not read would refuse every run on that row.
 */

describe("the version grammar", () => {
  const samples = [
    "1.18.33",
    "v1.18.33",
    "1.18",
    "2",
    "1.18.33-beta.2",
    "1.18.33+build.7",
    "1.18.33-rc.1+sha.abc",
    "latest",
    "",
    "1.18.x",
    "v",
    "1..2",
    "-1.0",
    " 1.2.3 ",
  ];
  for (const sample of samples) {
    it(`agrees between the form and the client on ${JSON.stringify(sample)}`, () => {
      expect(harnessVersionSchema.safeParse(sample).success).toBe(isReadableVersion(sample));
    });
  }
});

/**
 * The pin against the real binary — the one SoloW installs (`opencode-ai`, an exact dependency),
 * so this runs wherever the dependencies are installed, not only on a machine someone set up.
 * `SOLOW_TEST_OPENCODE_BIN` points it at another build instead. Through the same `probeHarness`
 * Settings uses — `initialize` and `session/new`, never a prompt, so no credential and no
 * inference — in a blank home, the way a Task's harness is started (Decision 0027).
 */
const OPENCODE = process.env["SOLOW_TEST_OPENCODE_BIN"] ?? bundledBinary("opencode");
const opencodeRow = DEFAULT_HARNESS_CATALOG.find((row) => row.key === "opencode");

if (OPENCODE) {
  describe("the opencode pin against the real binary (live)", () => {
    const probe = async (minVersion: string | null) => {
      const home = await mkdtemp(join(tmpdir(), "solow-opencode-live-"));
      try {
        return await probeHarness(createLocalExecutor(home), {
          command: OPENCODE,
          // As the orchestrator launches it: the seeded row's `--auto` is SoloW's, not opencode's.
          args: clientDirectives("acp", opencodeRow?.argsTemplate ?? ["acp"]).args,
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_DATA_HOME: join(home, ".local", "share"),
            XDG_CACHE_HOME: join(home, ".cache"),
            XDG_STATE_HOME: join(home, ".local", "state"),
          },
          cwd: home,
          protocol: "acp",
          minVersion,
          harnessName: opencodeRow?.displayName ?? "opencode",
          installHint: opencodeRow?.installHint ?? null,
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    };

    it("meets the pin the catalog seeds, and reports the build that answered", async () => {
      const result = await probe(opencodeRow?.minVersion ?? null);
      expect(result.reason).toBeNull();
      expect(result.ok).toBe(true);
      expect(result.agent?.version).toBeTruthy();
      console.log(`opencode reported ${result.agent?.name} ${result.agent?.version}`);
    }, 30_000);

    it("is refused, naming the build it found, by a pin above it", async () => {
      const result = await probe("999.0.0");
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("is older than 999.0.0");
      expect(result.reason).toContain(String(result.agent?.version));
    }, 30_000);
  });
} else {
  describe("the opencode pin against the real binary (live)", () => {
    it.skip("no opencode build for this platform was installed, and SOLOW_TEST_OPENCODE_BIN is unset", () => {});
  });
}
