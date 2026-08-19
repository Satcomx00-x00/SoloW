import { describe, expect, it } from "bun:test";
import { agentProtocolSchema } from "@gatecontrol/contracts";
import {
  AVAILABLE_AGENT_PROTOCOLS,
  hasAgentRunner,
  missingAgentRunnerReason,
} from "./protocols.js";

describe("agent protocol runners (issue #10)", () => {
  it("reports a runner only for the protocol actually implemented", () => {
    expect(hasAgentRunner("claude_code_stream_json")).toBe(true);
    for (const protocol of agentProtocolSchema.options) {
      expect(hasAgentRunner(protocol)).toBe(AVAILABLE_AGENT_PROTOCOLS.includes(protocol));
    }
  });

  it("names the protocol and what this build can drive", () => {
    const reason = missingAgentRunnerReason("acp");
    expect(reason).toContain("acp");
    expect(reason).toContain("claude_code_stream_json");
  });
});
