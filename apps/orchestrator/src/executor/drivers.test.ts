import { describe, expect, it } from "bun:test";
import { executorKindSchema } from "@solow/contracts";
import { AVAILABLE_EXECUTOR_KINDS, hasDriver, missingDriverReason } from "./drivers.js";

describe("executor drivers (issue #73)", () => {
  it("reports a driver only for the kinds actually implemented", () => {
    expect(hasDriver("local")).toBe(true);
    for (const kind of executorKindSchema.options) {
      expect(hasDriver(kind)).toBe(AVAILABLE_EXECUTOR_KINDS.includes(kind));
    }
  });

  it("names the kind and what this build can run, so the board reads legibly", () => {
    const reason = missingDriverReason("ssh");
    expect(reason).toContain("ssh");
    expect(reason).toContain("local");
  });
});
