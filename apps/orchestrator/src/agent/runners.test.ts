import { describe, expect, it } from "bun:test";
import { agentProtocolSchema } from "@solow/contracts";
import type { Executor } from "../executor/types.js";
import { AcpRunner } from "./acp-runner.js";
import { ClaudeCodeRunner } from "./claude-code-runner.js";
import { AVAILABLE_AGENT_PROTOCOLS, hasAgentRunner } from "./protocols.js";
import { createAgentRunner, unsupportedLaunchSettings } from "./runners.js";

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

/**
 * A launch setting the protocol cannot express (issue #94 AC-3).
 *
 * The rule is that a Profile's pin is either honoured or **said** — never quietly dropped. A run
 * that used a different model than the Profile asked for, with the Profile still reading as
 * though the pin held, is the silent substitution the criterion forbids by name.
 */
describe("unsupportedLaunchSettings", () => {
  it("names a model ACP has no way to select", () => {
    // `AcpMethod` carries `session/set_mode` and nothing for a model, so pinning one is a
    // request SoloW cannot make. Inventing a method name and hoping is how a run fails in
    // the middle instead of at the start.
    expect(unsupportedLaunchSettings("acp", { model: "opus" })).toEqual(['model "opus"']);
  });

  it("names a mode the stream-json CLI has no notion of", () => {
    expect(unsupportedLaunchSettings("claude_code_stream_json", { modeId: "plan" })).toEqual([
      'mode "plan"',
    ]);
  });

  it("says nothing about a setting the protocol does carry", () => {
    expect(unsupportedLaunchSettings("claude_code_stream_json", { model: "opus" })).toEqual([]);
    expect(unsupportedLaunchSettings("acp", { modeId: "plan" })).toEqual([]);
  });

  it("says nothing when a Profile pinned nothing at all", () => {
    // The ordinary case: null everywhere means "whatever the agent chooses".
    expect(unsupportedLaunchSettings("acp", { model: null, modeId: null })).toEqual([]);
  });
});
