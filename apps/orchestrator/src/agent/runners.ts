import type { AgentProtocol } from "@gatecontrol/contracts";
import type { Executor } from "../executor/types.js";
import { AcpRunner } from "./acp-runner.js";
import { ClaudeCodeRunner } from "./claude-code-runner.js";
import type { UnattendedPermissionPosture } from "./permissions.js";
import type { AgentRunner } from "./runner.js";

/**
 * Protocol → runner (issue #58, AC-3). The one switch in the product that turns a catalog row's
 * `protocol` column into something that can drive an agent.
 *
 * This is where "adding an agent is configuration, not engineering" (Decision 0003) becomes
 * true in code: a new agent whose protocol already has a driver is a database row, and a new
 * *protocol* is one case here rather than a new path through the lifecycle. `stream-json` is a
 * transport behind the same interface, not the architecture.
 *
 * `protocols.ts` answers "can this build drive it"; a test asserts the two agree for every
 * member of the enum, so the availability check and the driver cannot drift apart.
 */

export interface AgentRunnerDeps {
  /** Where the agent process runs — issue #1's `Executor`. */
  executor: Executor;
  /** How long an operator has to answer an ACP permission before the policy decides (AC-4). */
  permissionDeadlineMs?: number;
  /**
   * What an unanswered ACP permission decays to. Absent means refusal: the permissive posture
   * is reachable only by a deployment naming it (`GATECONTROL_ACP_UNATTENDED_PERMISSION`).
   */
  unattendedPermissionPosture?: UnattendedPermissionPosture;
}

export function createAgentRunner(
  protocol: AgentProtocol,
  deps: AgentRunnerDeps,
): AgentRunner | null {
  switch (protocol) {
    case "claude_code_stream_json":
      return new ClaudeCodeRunner({ executor: deps.executor });
    case "acp":
      return new AcpRunner({
        executor: deps.executor,
        ...(deps.permissionDeadlineMs === undefined
          ? {}
          : { permissionDeadlineMs: deps.permissionDeadlineMs }),
        ...(deps.unattendedPermissionPosture === undefined
          ? {}
          : { unattendedPermissionPosture: deps.unattendedPermissionPosture }),
      });
    // #21's passthrough: named in the enum ahead of its driver, the same way #73 named the
    // Docker/SSH/cloud Executor kinds. Null, not a default runner — a Task pointed at a
    // protocol nothing speaks must fail with the reason named, never fall through to whatever
    // the last case happened to do.
    case "cli_passthrough":
      return null;
  }
}
