import { describe, expect, it } from "bun:test";
import { agentProtocolSchema } from "@gatecontrol/contracts";
import type { Executor } from "../executor/types.js";
import { AcpRunner } from "./acp-runner.js";
import { ClaudeCodeRunner } from "./claude-code-runner.js";
import { AVAILABLE_AGENT_PROTOCOLS, hasAgentRunner } from "./protocols.js";
import { createAgentRunner } from "./runners.js";

/**
 * The protocol → runner switch (issue #58, AC-3). The point of these is drift: the lifecycle
 * asks `hasAgentRunner` whether a Task can run at all, and `createAgentRunner` for the thing
 * that runs it. If those two ever disagreed, a Task would pass the availability check and then
 * find nothing to drive it — or be failed for a protocol this build can actually speak.
 */

/** The switch never touches the executor; it only hands it to whichever runner it builds. */
const executor = {} as Executor;

describe("createAgentRunner", () => {
  it("agrees with hasAgentRunner for every protocol in the enum", () => {
    for (const protocol of agentProtocolSchema.options) {
      expect(createAgentRunner(protocol, { executor }) !== null).toBe(hasAgentRunner(protocol));
    }
  });

  it("drives ACP with the real ACP client (Decision 0003)", () => {
    expect(createAgentRunner("acp", { executor })).toBeInstanceOf(AcpRunner);
  });

  it("keeps Claude Code's stream-JSON as an adapter behind the same interface", () => {
    expect(createAgentRunner("claude_code_stream_json", { executor })).toBeInstanceOf(
      ClaudeCodeRunner,
    );
  });

  it("returns nothing for a protocol named ahead of its driver", () => {
    // A default runner here would silently run a passthrough Task as something else entirely.
    expect(createAgentRunner("cli_passthrough", { executor })).toBeNull();
    expect(AVAILABLE_AGENT_PROTOCOLS).not.toContain("cli_passthrough");
  });
});
