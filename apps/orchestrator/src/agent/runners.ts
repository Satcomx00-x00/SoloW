import type { AgentPermissionMode, AgentProtocol } from "@gatecontrol/contracts";
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
  /**
   * How much the agent may do without asking, from its Agent Profile (spec F05).
   *
   * It means the same thing on both protocols, by different mechanics — which is the whole
   * point of it being one setting:
   *
   * - stream-json takes it as the CLI's own `--permission-mode`.
   * - ACP has a request channel instead, so `bypassPermissions` becomes "answer every request
   *   at once with the narrowest allow the agent offered". The request and its resolution are
   *   still published and still logged, recorded as decided by `policy` rather than by an
   *   operator — a run where nobody looked must never read afterwards as one where somebody did.
   *
   * Anything other than `bypassPermissions` leaves ACP on the deployment's own unattended
   * posture below, which refuses unless a deployment named otherwise.
   */
  permissionMode?: AgentPermissionMode;
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
      return new ClaudeCodeRunner({
        executor: deps.executor,
        ...(deps.permissionMode === undefined ? {} : { permissionMode: deps.permissionMode }),
      });
    case "acp": {
      // A Profile that never asks answers immediately: a deadline is how long a *person* gets,
      // and making an agent wait two minutes per tool call for a decision nobody is coming to
      // make would be the same stall in slower clothing.
      const bypassing = deps.permissionMode === "bypassPermissions";
      return new AcpRunner({
        executor: deps.executor,
        ...(bypassing
          ? { permissionDeadlineMs: 0, unattendedPermissionPosture: "allow_once" as const }
          : {
              ...(deps.permissionDeadlineMs === undefined
                ? {}
                : { permissionDeadlineMs: deps.permissionDeadlineMs }),
              ...(deps.unattendedPermissionPosture === undefined
                ? {}
                : { unattendedPermissionPosture: deps.unattendedPermissionPosture }),
            }),
      });
    }
    // #21's passthrough: named in the enum ahead of its driver, the same way #73 named the
    // Docker/SSH/cloud Executor kinds. Null, not a default runner — a Task pointed at a
    // protocol nothing speaks must fail with the reason named, never fall through to whatever
    // the last case happened to do.
    case "cli_passthrough":
      return null;
  }
}
