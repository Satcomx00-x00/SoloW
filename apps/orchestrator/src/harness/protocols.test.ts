import { describe, expect, it } from "bun:test";
import { harnessProtocolSchema } from "@solow/contracts";
import {
  AVAILABLE_HARNESS_PROTOCOLS,
  harnessCreatesOwnWorktree,
  hasHarnessRunner,
  missingHarnessRunnerReason,
} from "./protocols.js";

describe("harness protocol runners (issues #10 and #58)", () => {
  it("reports a runner only for the protocols actually implemented", () => {
    expect(hasHarnessRunner("claude_code_stream_json")).toBe(true);
    // Issue #58 is precisely the work of making this true; before it, `acp` was a name with no
    // driver behind it.
    expect(hasHarnessRunner("acp")).toBe(true);
    for (const protocol of harnessProtocolSchema.options) {
      expect(hasHarnessRunner(protocol)).toBe(AVAILABLE_HARNESS_PROTOCOLS.includes(protocol));
    }
  });

  it("names the protocol and what this build can drive", () => {
    // `cli_passthrough` (#21) is the one still named ahead of its driver.
    const reason = missingHarnessRunnerReason("cli_passthrough");
    expect(reason).toContain("cli_passthrough");
    expect(reason).toContain("claude_code_stream_json");
    expect(reason).toContain("acp");
  });
});

describe("harnessCreatesOwnWorktree", () => {
  it("says Claude Code makes its own worktree and an ACP agent does not", () => {
    // This is the one thing the lifecycle has to branch on: who creates the directory. The
    // isolation guarantee is the same either way (Principle II).
    expect(harnessCreatesOwnWorktree("claude_code_stream_json")).toBe(true);
    expect(harnessCreatesOwnWorktree("acp")).toBe(false);
  });
});
