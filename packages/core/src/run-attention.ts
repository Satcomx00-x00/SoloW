import type { AttentionCause, AttentionKind, SessionState, TaskState } from "@solow/contracts";
import { STRANDED_REVIEW_REASON } from "./billing.js";

/**
 * When a run needs a person (FINDINGS F3): the one rule for "failed or stuck", shared by the
 * orchestrator's reconciliation sweep, which acts on it, and the web app, which shows it.
 *
 * The sweep (`apps/orchestrator/src/reconcile.ts`) already decides when a run is lost; what it
 * could not do is say so anywhere but a log line. The thresholds it measures by live here so the
 * list the user reads and the sweep that writes verdicts cannot disagree about what "quiet for
 * too long" means. The sweep owns everything that needs the harness registry (whether a run is
 * registered in this process); this module is only the clock and the row. The causes it assigns
 * are `attentionCauseSchema` in `@solow/contracts`, which says what each one means.
 */

/**
 * How quiet a `running` Task has to have gone before the sweep will call it orphaned.
 *
 * Sized against the widest legitimate gap between two durable steps, not against how long a tool
 * call takes: a long tool call happens inside `agent-run`, where the registry check settles it
 * first. Ten minutes is far beyond any observed step scheduling delay and still bounds how long a
 * user stares at a dead Task.
 */
export const RECLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * How long a parked run sleeps before it wakes itself up.
 *
 * The park step's own window (`PARK_SLEEP_MS` in the orchestrator's run engine), restated because
 * neither the sweep nor the web app may import the run engine. `reconcile.test.ts` pins the two
 * equal, so changing one alone is a red test rather than a sweep that condemns sleepers.
 */
export const PARK_WINDOW_MS = 5 * 60 * 60 * 1000;

/**
 * How quiet a `running` Task has to be before the user is told it may be stuck.
 *
 * Twice the reclaim window, because by then the sweep has had a full window of its own to act: a
 * run that is not registered anywhere is relaunched (which writes to its log, so it is no longer
 * quiet) or filed `failed`. A Task still `running` and silent past this is a registered harness
 * that has said nothing for twenty minutes, or an orchestrator that is not sweeping at all. Either
 * is worth a look, and neither is something the product can settle without a person, so this is a
 * notice and never a verdict: nothing writes a state because of it.
 */
export const QUIET_RUN_MS = 2 * RECLAIM_STALE_MS;

/**
 * The `failureReason` a Task carries when the run sleeping out its quota window never came back.
 *
 * Not a failure of the work: the worktree and its commits are untouched, and one Retry starts the
 * round the sleep was supposed to start. Written by the sweep's `reportStrandedParks`, cleared by
 * the park step when its sleep returns.
 */
export const STRANDED_PARK_REASON = "park_never_resumed";

/** A `running` Task's run is lost once it has been silent this long (and is not registered). */
export function silentPastReclaim(lastActivityMs: number, nowMs: number): boolean {
  return nowMs - lastActivityMs >= RECLAIM_STALE_MS;
}

/** A parked run has missed its own wake-up once silent past a whole window and a reclaim. */
export function parkOverdue(lastActivityMs: number, nowMs: number): boolean {
  return nowMs - lastActivityMs >= PARK_WINDOW_MS + RECLAIM_STALE_MS;
}

export interface RunAttentionInput {
  state: TaskState;
  failureReason: string | null;
  /** The Task row's last write: when it failed, or was last moved. ISO-8601. */
  updatedAt: string;
  /**
   * The newest sign of life from the run: its newest Session's newest event, else that Session's
   * start, else the Task row's last write. ISO-8601.
   */
  lastActivityAt: string;
  /** The newest Session's state, or null for a Task that has never run. */
  sessionState: SessionState | null;
}

export interface RunAttention {
  kind: AttentionKind;
  cause: AttentionCause;
  /** When the condition began, as best the rows can say. ISO-8601. */
  since: string;
}

/** Does this Task need a person, and why. */
export function runAttention(input: RunAttentionInput, nowMs: number): RunAttention | null {
  if (input.state === "failed") {
    return { kind: "failed", cause: "failed", since: input.updatedAt };
  }
  if (input.state === "review") {
    return input.failureReason === STRANDED_REVIEW_REASON
      ? { kind: "stuck", cause: "decision_not_applied", since: input.updatedAt }
      : null;
  }
  // A run that finished leaves its Session at the gate while the Task can still read `running` or
  // `parked` until a person opens the review. That is work waiting for a person, which the board
  // already shows as finished — the same exclusion both sweeps make.
  if (input.sessionState === "awaiting_review") return null;

  const last = lastSignOfLife(input);
  if (input.state === "parked") {
    if (input.failureReason === STRANDED_PARK_REASON) {
      return { kind: "stuck", cause: "park_never_resumed", since: input.lastActivityAt };
    }
    // Only a reasonless park is a sleep the clock can judge: the park step clears the reason when
    // it parks, and `reportStrandedParks` selects exactly those rows.
    if (input.failureReason !== null) return null;
    return parkOverdue(last, nowMs)
      ? { kind: "stuck", cause: "park_overdue", since: new Date(last).toISOString() }
      : null;
  }
  if (input.state === "running") {
    return nowMs - last >= QUIET_RUN_MS
      ? { kind: "stuck", cause: "run_silent", since: new Date(last).toISOString() }
      : null;
  }
  return null;
}

/**
 * When a Task that needs nothing now would start to, or null if the clock alone never changes it.
 *
 * So a screen can look again at exactly that moment instead of polling: a run going quiet produces
 * no event by definition, and this is the only other signal there is. Any later activity pushes
 * the moment back, and the re-read at the old moment simply finds nothing new.
 */
export function attentionDueAt(input: RunAttentionInput): number | null {
  if (input.sessionState === "awaiting_review") return null;
  if (input.state === "running") return lastSignOfLife(input) + QUIET_RUN_MS;
  if (input.state === "parked" && input.failureReason === null) {
    return lastSignOfLife(input) + PARK_WINDOW_MS + RECLAIM_STALE_MS;
  }
  return null;
}

/**
 * The newest of the run's log and the Task row, because they record different halves of a round:
 * the Session carries what the harness said, the row carries the park or the relaunch itself.
 */
function lastSignOfLife(input: RunAttentionInput): number {
  return Math.max(Date.parse(input.lastActivityAt), Date.parse(input.updatedAt));
}
