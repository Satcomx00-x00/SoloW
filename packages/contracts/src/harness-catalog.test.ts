import { describe, expect, it } from "bun:test";
import { createHarnessCatalogEntryInput, harnessCatalogEntryDto } from "./harness-catalog.js";

/**
 * A catalog row's `minVersion`: what the form accepts is what the ACP client can read, because a
 * pin it could not read would refuse every run on the row (see `harnessVersionSchema`).
 */

const row = (over: Record<string, unknown> = {}) => ({
  key: "my_harness",
  displayName: "Mine",
  protocol: "acp",
  command: "mine",
  subscriptionEnvVar: "MINE_TOKEN",
  meteredEnvVar: "MINE_KEY",
  ...over,
});

describe("createHarnessCatalogEntryInput — minVersion", () => {
  it("defaults to no pin, as every row a Workspace adds itself starts", () => {
    const parsed = createHarnessCatalogEntryInput.parse(row());
    expect(parsed.minVersion).toBeNull();
  });

  it("accepts a version the way release tags write one", () => {
    for (const version of ["1.18.33", "v2.0.0", "1.18", "1.0.0-rc.1", "3.1.4+build.9"]) {
      expect(createHarnessCatalogEntryInput.safeParse(row({ minVersion: version })).success).toBe(
        true,
      );
    }
  });

  it("trims what was pasted around it", () => {
    expect(createHarnessCatalogEntryInput.parse(row({ minVersion: " 1.18.33 " })).minVersion).toBe(
      "1.18.33",
    );
  });

  it("refuses what is not a version rather than storing a pin nothing can meet", () => {
    for (const bad of ["latest", "1.18.x", "", ">=1.18", "one"]) {
      expect(createHarnessCatalogEntryInput.safeParse(row({ minVersion: bad })).success).toBe(
        false,
      );
    }
  });
});

describe("harnessCatalogEntryDto", () => {
  it("carries the pin to the client, and requires the field so a row cannot silently drop it", () => {
    const dto = {
      id: "11111111-1111-4111-8111-111111111111",
      key: "opencode",
      displayName: "opencode",
      protocol: "acp",
      command: "opencode",
      argsTemplate: ["acp"],
      installHint: "npm install -g opencode-ai@latest",
      subscriptionEnvVar: "OPENCODE_API_KEY",
      meteredEnvVar: "ANTHROPIC_API_KEY",
      capabilities: { models: [], modes: [] },
      createdAt: "2026-09-28T00:00:00.000Z",
      updatedAt: "2026-09-28T00:00:00.000Z",
    };
    expect(harnessCatalogEntryDto.parse({ ...dto, minVersion: "1.18.33" }).minVersion).toBe(
      "1.18.33",
    );
    expect(harnessCatalogEntryDto.safeParse(dto).success).toBe(false);
  });
});
