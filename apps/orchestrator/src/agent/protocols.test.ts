import { describe, expect, it } from "bun:test";
import { agentProtocolSchema } from "@gatecontrol/contracts";
import {
  AVAILABLE_AGENT_PROTOCOLS,
  agentCreatesOwnWorktree,
  hasAgentRunner,
  missingAgentRunnerReason,
} from "./protocols.js";

describe("agent protocol runners (issues #10 and #58)", () => {
  it("reports a runner only for the protocols actually implemented", () => {
    expect(hasAgentRunner("claude_code_stream_json")).toBe(true);
    // Issue #58 is precisely the work of making this true; before it, `acp` was a name with no
    // driver behind it.
    expect(hasAgentRunner("acp")).toBe(true);
    for (const protocol of agentProtocolSchema.options) {
      expect(hasAgentRunner(protocol)).toBe(AVAILABLE_AGENT_PROTOCOLS.includes(protocol));
    }
  });

  it("names the protocol and what this build can drive", () => {
    // `cli_passthrough` (#21) is the one still named ahead of its driver.
    const reason = missingAgentRunnerReason("cli_passthrough");
    expect(reason).toContain("cli_passthrough");
    expect(reason).toContain("claude_code_stream_json");
    expect(reason).toContain("acp");
  });
});

describe("agentCreatesOwnWorktree", () => {
  it("says Claude Code makes its own worktree and an ACP agent does not", () => {
    // This is the one thing the lifecycle has to branch on: who creates the directory. The
    // isolation guarantee is the same either way (Principle II).
    expect(agentCreatesOwnWorktree("claude_code_stream_json")).toBe(true);
    expect(agentCreatesOwnWorktree("acp")).toBe(false);
  });
});
