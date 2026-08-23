import {
  BillingErrorCode,
  CommonErrorCode,
  TaskDependencyErrorCode,
  TaskErrorCode,
} from "@gatecontrol/contracts";

/**
 * Wire codes an action banner can receive, as sentences.
 *
 * Two surfaces read through this now — the board's banner and the Task page's, which shows the
 * same refusals for the arrows beside the state badge. So none of the wording may name a page:
 * "reload the board" is not an action available to someone standing on `/task/[id]`.
 *
 * The banner used to render `error.message` directly, which is the raw code — an Owner who hit
 * their Agent Profile's concurrency cap was shown `TASK_CONCURRENCY_CAP_REACHED` and left to
 * guess. Every code a launch or a move can fail with is answered here, and anything unmapped
 * falls back to a generic sentence rather than leaking a new code the next time one is added.
 *
 * The wording says what to *do*, not what went wrong: these appear at the moment the Owner's
 * click did nothing, and "why" without "next" is where they get stuck.
 */
const MESSAGES: Record<string, string> = {
  [TaskDependencyErrorCode.Blocked]:
    "Can't start this task yet — it is waiting on a task that isn't done.",
  [TaskErrorCode.ConcurrencyCapReached]:
    "This agent profile is already running as many tasks as it allows. Wait for one to finish, or delete a task that is stuck.",
  [TaskErrorCode.NotReady]: "This task isn't ready to start. Move it to Ready first.",
  [TaskErrorCode.IllegalTransition]: "That move isn't allowed from this task's current state.",
  [TaskErrorCode.RepositoryUnreachable]:
    "The task's repository could not be reached. Check the repository is still connected in Settings.",
  [TaskErrorCode.AgentUnavailable]:
    "The agent for this task is unavailable. Check its agent profile in Settings.",
  [TaskErrorCode.StillRunning]:
    "An agent is still running on this task and could not be stopped, so nothing was deleted.",
  [TaskErrorCode.StopFailed]:
    "The agent could not be stopped, so nothing was deleted. Check the orchestrator is running, then try again.",
  [TaskErrorCode.HasDependents]:
    "Other tasks are waiting on this one. Deleting it would unblock them.",
  [CommonErrorCode.RateLimited]: "Too many launches in a row. Wait a moment and try again.",
  [CommonErrorCode.Forbidden]: "You do not have permission to do that.",
  [CommonErrorCode.NotFound]: "That task no longer exists — this page may be out of date.",
  [BillingErrorCode.MissingCredential]:
    "This agent profile has no credential set. Add one in Settings before launching.",
  [BillingErrorCode.CredentialExpired]:
    "The agent's credential was rejected. Update it in Settings, then try again.",
  [BillingErrorCode.QuotaExhausted]: "The agent's quota is exhausted.",
};

/**
 * A sentence for a failed Task action. `null` in, `null` out, so callers can pass an optional
 * error message straight through.
 */
export function taskActionMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? "That didn't work. Try again, or reload the page.";
}
