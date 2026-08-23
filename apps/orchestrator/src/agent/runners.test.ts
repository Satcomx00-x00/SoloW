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

  it("carries the Profile's permission mode to the stream-json runner", () => {
    // The posture is per Agent Profile (spec F05), so the factory takes it per call rather than
    // per process: two Tasks in one Workspace can run the same agent under different postures.
    const runner = createAgentRunner("claude_code_stream_json", {
      executor,
      permissionMode: "bypassPermissions",
    });
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
    // Read off the instance rather than through a getter the runner does not need: what matters
    // is that the factory handed the posture on, not how the runner stores it.
    const carried = (runner as unknown as { options: { permissionMode?: string } }).options;
    expect(carried.permissionMode).toBe("bypassPermissions");
  });

  it("turns a never-ask Profile into immediate ACP approval, not a slow one", () => {
    // ACP has a request channel, so "never ask" cannot mean "pass a flag" — it means answering
    // for the operator, at once. A deadline is how long a *person* gets; waiting it out for a
    // decision nobody is coming to make would be the same stall in slower clothing.
    const runner = createAgentRunner("acp", {
      executor,
      permissionMode: "bypassPermissions",
      unattendedPermissionPosture: "refuse",
    });
    const options = (runner as unknown as { options: Record<string, unknown> }).options;
    expect(options["permissionDeadlineMs"]).toBe(0);
    expect(options["unattendedPermissionPosture"]).toBe("allow_once");
  });

  it("leaves an asking Profile on the deployment's own posture", () => {
    const runner = createAgentRunner("acp", {
      executor,
      permissionMode: "acceptEdits",
      unattendedPermissionPosture: "refuse",
    });
    const options = (runner as unknown as { options: Record<string, unknown> }).options;
    // Untouched: a Profile that still asks must not have its deployment's refusal widened for it.
    expect(options["unattendedPermissionPosture"]).toBe("refuse");
    expect(options["permissionDeadlineMs"]).toBeUndefined();
  });

  it("returns nothing for a protocol named ahead of its driver", () => {
    // A default runner here would silently run a passthrough Task as something else entirely.
    expect(createAgentRunner("cli_passthrough", { executor })).toBeNull();
    expect(AVAILABLE_AGENT_PROTOCOLS).not.toContain("cli_passthrough");
  });
});
