import type { AgentPermissionMode, AgentProtocol } from "@solow/contracts";
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
  /**
   * The model and mode the Profile pinned, or absent for "whatever the agent chooses"
   * (issue #94).
   *
   * Both travel to the protocol that can express them and nowhere else: stream-json takes a
   * model as `--model`, ACP selects a mode through `session/set_mode`, and neither speaks the
   * other's. A setting a protocol cannot carry is reported rather than dropped — see
   * `unsupportedLaunchSettings`.
   */
  model?: string;
  modeId?: string;
  /** How long an operator has to answer an ACP permission before the policy decides (AC-4). */
  permissionDeadlineMs?: number;
  /**
   * What an unanswered ACP permission decays to. Absent means refusal: the permissive posture
   * is reachable only by a deployment naming it (`SOLOW_ACP_UNATTENDED_PERMISSION`).
   */
  unattendedPermissionPosture?: UnattendedPermissionPosture;
}

/**
 * What an Agent Profile asked its agent to be launched with (issue #94).
 *
 * One object rather than a widening parameter list, because these travel together and are
 * chosen together: a Profile is the thing that says "Opus, in plan mode, never asking".
 */
export interface AgentLaunchSettings {
  permissionMode: AgentPermissionMode;
  /** Absent means "whatever the agent chooses" — never a default written down here. */
  model?: string;
  modeId?: string;
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
        ...(deps.model === undefined ? {} : { model: deps.model }),
      });
    case "acp": {
      // A Profile that never asks answers immediately: a deadline is how long a *person* gets,
      // and making an agent wait two minutes per tool call for a decision nobody is coming to
      // make would be the same stall in slower clothing.
      const bypassing = deps.permissionMode === "bypassPermissions";
      return new AcpRunner({
        executor: deps.executor,
        // Only ever an id the agent itself advertised — the client checks the list before
        // sending `session/set_mode` rather than sending a guess and reading the error.
        ...(deps.modeId === undefined ? {} : { modeId: deps.modeId }),
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

/**
 * The launch settings this protocol cannot carry, named.
 *
 * A Profile can pin a model and a mode; a protocol speaks one, the other, or neither. Dropping
 * the ones it cannot express would be the silent substitution AC-3 exists to forbid — a run that
 * quietly used a different model than the Profile asked for, with nothing on screen to say so.
 * So the lifecycle asks this and says what it could not honour.
 */
export function unsupportedLaunchSettings(
  protocol: AgentProtocol,
  settings: { model?: string | null; modeId?: string | null },
): string[] {
  const unsupported: string[] = [];
  // stream-json launches a CLI with `--model` and has no notion of a session mode.
  if (protocol === "claude_code_stream_json" && settings.modeId) {
    unsupported.push(`mode "${settings.modeId}"`);
  }
  /*
   * ACP advertises models at handshake but this build's vocabulary has no `session/select_model`
   * — `AcpMethod` carries `session/set_mode` and nothing for a model. Pinning one is therefore
   * a request SoloW cannot make, and saying so is the only honest answer; inventing a
   * method name and hoping is how a run fails in the middle instead of at the start.
   */
  if (protocol === "acp" && settings.model) unsupported.push(`model "${settings.model}"`);
  return unsupported;
}
