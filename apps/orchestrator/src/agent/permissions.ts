import type { AcpPermissionOption, AcpPermissionRequest } from "@solow/acp";
import type { PermissionAnswer } from "./runner.js";

/**
 * Pending permission requests for one run (issue #58, AC-4).
 *
 * The ACP session asks; the operator answers through the WebSocket hub and the agent registry.
 * Between the two sits this inbox, which knows nothing about hubs, sockets or the database — it
 * holds the outstanding requests, matches an answer to one, and decides what happens when
 * nobody answers.
 *
 * **What happens when nobody answers is the interesting decision, and the answer is "no".** AC-4
 * says a permission must be surfaced to the operator *rather than silently granting it*, and an
 * auto-grant on a two-minute timer is a silent grant with a delay in front of it. It is also a
 * wider posture than the Claude Code path it has to match: `--permission-mode acceptEdits`
 * waves through file edits and still stops for everything else, whereas taking whatever the
 * agent labelled `allow_once` grants whatever the agent happened to be asking for. So an
 * unattended request is *refused* when the deadline passes, recorded as decided by the policy.
 *
 * The run does not hang either way — a refusal releases the turn as surely as a grant does, and
 * the agent gets the same answer it would get from an operator who said no. What it costs is
 * that an unattended run asking for something it needs will end early rather than proceeding
 * without consent, which is the trade AC-4 asks for.
 *
 * The permissive behaviour is still reachable, but only by naming it: `"allow_once"` as the
 * posture. That direction is deliberate — a deployment can widen its own posture on purpose,
 * and no deployment can widen it by leaving something unset.
 */

/** How long an operator has to answer before the fallback policy decides. */
export const PERMISSION_DEADLINE_MS = 120_000;

/**
 * What an unanswered permission decays to. `refuse` is the default and the only value a
 * deployment gets without asking for something else.
 */
export type UnattendedPermissionPosture = "refuse" | "allow_once";

export const DEFAULT_UNATTENDED_POSTURE: UnattendedPermissionPosture = "refuse";

export type PermissionDecidedBy = "operator" | "policy";

export interface PermissionResolution {
  outcome: "selected" | "cancelled";
  optionId: string | null;
  decidedBy: PermissionDecidedBy;
}

/**
 * What the policy answers when nobody did.
 *
 * `refuse` declines without choosing any of the agent's options — the same shape as an operator
 * closing the question, and the one answer that cannot grant something nobody consented to.
 *
 * `allow_once` is the opt-in posture, and even then it takes the *narrowest* allow the agent
 * offered: `allow_once` grants exactly the action asked about, whereas `allow_always` grants
 * every future one of its kind for the rest of the session, so a one-shot allow wins even when
 * a blanket one is listed first. An agent that offered no allow at all gets a refusal.
 */
export function headlessFallbackPolicy(
  options: readonly AcpPermissionOption[],
  posture: UnattendedPermissionPosture = DEFAULT_UNATTENDED_POSTURE,
): PermissionResolution {
  const refusal: PermissionResolution = {
    outcome: "cancelled",
    optionId: null,
    decidedBy: "policy",
  };
  if (posture === "refuse") return refusal;
  const once = options.find((o) => o.kind === "allow_once");
  const always = options.find((o) => o.kind === "allow_always");
  const chosen = once ?? always;
  return chosen ? { outcome: "selected", optionId: chosen.optionId, decidedBy: "policy" } : refusal;
}

interface Pending {
  options: AcpPermissionOption[];
  settle: (resolution: PermissionResolution) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PermissionInbox {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly deadlineMs: number = PERMISSION_DEADLINE_MS,
    private readonly posture: UnattendedPermissionPosture = DEFAULT_UNATTENDED_POSTURE,
  ) {}

  /** Requests still waiting on somebody. */
  get size(): number {
    return this.pending.size;
  }

  /** Hold a request open until the operator answers or the deadline decides for them. */
  ask(request: AcpPermissionRequest): Promise<PermissionResolution> {
    return new Promise<PermissionResolution>((resolve) => {
      const settle = (resolution: PermissionResolution) => {
        const entry = this.pending.get(request.requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(request.requestId);
        resolve(resolution);
      };
      const timer = setTimeout(
        () => settle(headlessFallbackPolicy(request.options, this.posture)),
        this.deadlineMs,
      );
      this.pending.set(request.requestId, { options: request.options, settle, timer });
    });
  }

  /**
   * The operator's answer, and what became of it.
   *
   * The two ways it can fail are genuinely different things to be told: `not_pending` means the
   * question is over — a stale dialog, or one the deadline settled while the operator was
   * reading it — and `option_not_offered` means the click did not match anything the agent put
   * on the table. Collapsing them into one "no" was the old behaviour, and it left the terminal
   * telling an operator that the agent was not running while it was mid-turn.
   */
  answer(requestId: string, optionId: string): PermissionAnswer {
    const entry = this.pending.get(requestId);
    if (!entry) return "not_pending";
    // Only an option the agent actually offered: SoloW never invents one, for the same
    // reason it never assumes a capability that was not advertised (AC-2).
    if (!entry.options.some((o) => o.optionId === optionId)) return "option_not_offered";
    entry.settle({ outcome: "selected", optionId, decidedBy: "operator" });
    return "answered";
  }

  /** Settle everything outstanding when the run ends, so no `session/prompt` is left hanging. */
  close(): void {
    for (const [, entry] of [...this.pending]) {
      entry.settle({ outcome: "cancelled", optionId: null, decidedBy: "policy" });
    }
  }
}
