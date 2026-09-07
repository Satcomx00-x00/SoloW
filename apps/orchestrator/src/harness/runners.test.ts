import { describe, expect, it } from "bun:test";
import { HARNESS_PROTOCOL_PINS, harnessProtocolSchema } from "@solow/contracts";
import type { Executor } from "../executor/types.js";
import { AcpRunner } from "./acp-runner.js";
import { ClaudeCodeRunner } from "./claude-code-runner.js";
import { CliPassthroughRunner } from "./cli-passthrough-runner.js";
import { AVAILABLE_HARNESS_PROTOCOLS, hasHarnessRunner } from "./protocols.js";
import { createHarnessRunner, unsupportedLaunchSettings } from "./runners.js";

/**
 * The protocol → runner switch (issue #58, AC-3). The point of these is drift: the lifecycle
 * asks `hasHarnessRunner` whether a Task can run at all, and `createHarnessRunner` for the thing
 * that runs it. If those two ever disagreed, a Task would pass the availability check and then
 * find nothing to drive it — or be failed for a protocol this build can actually speak.
 */

/** The switch never touches the executor; it only hands it to whichever runner it builds. */
const executor = {} as Executor;

describe("createHarnessRunner", () => {
  it("agrees with hasHarnessRunner for every protocol in the enum", () => {
    for (const protocol of harnessProtocolSchema.options) {
      expect(createHarnessRunner(protocol, { executor }) !== null).toBe(hasHarnessRunner(protocol));
    }
  });

  it("drives ACP with the real ACP client (Decision 0003)", () => {
    expect(createHarnessRunner("acp", { executor })).toBeInstanceOf(AcpRunner);
  });

  it("keeps Claude Code's stream-JSON as an adapter behind the same interface", () => {
    expect(createHarnessRunner("claude_code_stream_json", { executor })).toBeInstanceOf(
      ClaudeCodeRunner,
    );
  });

  it("carries the Profile's permission mode to the stream-json runner", () => {
    // The posture is per Harness Profile (spec F05), so the factory takes it per call rather than
    // per process: two Tasks in one Workspace can run the same harness under different postures.
    const runner = createHarnessRunner("claude_code_stream_json", {
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
    const runner = createHarnessRunner("acp", {
      executor,
      permissionMode: "bypassPermissions",
      unattendedPermissionPosture: "refuse",
    });
    const options = (runner as unknown as { options: Record<string, unknown> }).options;
    expect(options["permissionDeadlineMs"]).toBe(0);
    expect(options["unattendedPermissionPosture"]).toBe("allow_once");
  });

  it("leaves an asking Profile on the deployment's own posture", () => {
    const runner = createHarnessRunner("acp", {
      executor,
      permissionMode: "acceptEdits",
      unattendedPermissionPosture: "refuse",
    });
    const options = (runner as unknown as { options: Record<string, unknown> }).options;
    // Untouched: a Profile that still asks must not have its deployment's refusal widened for it.
    expect(options["unattendedPermissionPosture"]).toBe("refuse");
    expect(options["permissionDeadlineMs"]).toBeUndefined();
  });

  it("drives a plain CLI, so a harness that speaks neither protocol is still a data row", () => {
    // #21's passthrough, driven since 2026-08-28. Until then this protocol was named in the
    // enum with nothing behind it, and "adding a harness is a data row" was true only for harnesses
    // that already spoke one of the other two.
    expect(createHarnessRunner("cli_passthrough", { executor })).toBeInstanceOf(
      CliPassthroughRunner,
    );
    expect(AVAILABLE_HARNESS_PROTOCOLS).toContain("cli_passthrough");
  });

  it("has a driver for every protocol the enum names", () => {
    // True today, and the assertion that will fail first the next time a protocol is named
    // ahead of its driver — which is the moment `hasHarnessRunner`'s refusal path matters again.
    for (const protocol of harnessProtocolSchema.options) {
      expect(createHarnessRunner(protocol, { executor })).not.toBeNull();
    }
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
  it("says nothing about either pin for ACP, which can express both", () => {
    // `session/set_mode` and `session/set_model`, both sent only for an id the harness advertised
    // in `session/new` — so neither is a guess, and neither is silently dropped.
    expect(unsupportedLaunchSettings("acp", { model: "opus", modeId: "plan" })).toEqual([]);
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
    // The ordinary case: null everywhere means "whatever the harness chooses".
    expect(unsupportedLaunchSettings("acp", { model: null, modeId: null })).toEqual([]);
  });

  it("reports exactly what HARNESS_PROTOCOL_PINS says, for every protocol", () => {
    /*
     * The drift guard for the *other* consumer of this rule. The Harness Profile form disables the
     * pin a protocol cannot be told, and it reads `HARNESS_PROTOCOL_PINS` to decide — so if this
     * function and that constant ever disagreed, the form would accept a setting the run then
     * reports it could not honour, which is the silent substitution both exist to prevent.
     */
    for (const protocol of harnessProtocolSchema.options) {
      const pins = HARNESS_PROTOCOL_PINS[protocol];
      const reported = unsupportedLaunchSettings(protocol, { model: "m", modeId: "d" });
      expect(reported.some((r) => r.startsWith("model"))).toBe(!pins.model);
      expect(reported.some((r) => r.startsWith("mode "))).toBe(!pins.mode);
    }
  });
});
