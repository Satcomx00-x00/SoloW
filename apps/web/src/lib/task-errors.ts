import { CommonErrorCode } from "@solow/contracts";
import { describeOptionalError } from "./errors";

/**
 * The shared table (`./errors`) said the way the Task surfaces need it.
 *
 * Two surfaces read through this — the board's banner and the Task page's, which shows the same
 * refusals for the arrows beside the state badge — plus History and the review gate. On all of
 * them the thing that went missing or was throttled is a task or a launch, so those two codes can
 * say so; every other code reads exactly as it does anywhere else in the app.
 *
 * The banner used to render `error.message` directly, which is the raw code — an Owner who hit
 * their Harness Profile's concurrency cap was shown `TASK_CONCURRENCY_CAP_REACHED` and left to
 * guess.
 */
const TASK_WORDING: Readonly<Record<string, string>> = {
  [CommonErrorCode.RateLimited]: "Too many launches in a row. Wait a moment and try again.",
  [CommonErrorCode.NotFound]: "That task no longer exists — this page may be out of date.",
};

/**
 * A sentence for a failed Task action. `null` in, `null` out, so callers can pass an optional
 * error message straight through.
 */
export function taskActionMessage(code: string | null | undefined): string | null {
  return describeOptionalError(code, TASK_WORDING);
}
