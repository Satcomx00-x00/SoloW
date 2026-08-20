import {
  err,
  ok,
  type Result,
  type WorkflowAdvanceOn,
  type WorkflowAdvanceStatus,
  WorkflowErrorCode,
  type WorkflowStepGate,
} from "@gatecontrol/contracts";

/**
 * Pure Workflow logic (issue #5, spec F03). Zero infrastructure imports; returns `Result`,
 * never throws on a business error (constitution Principle VI).
 *
 * Everything a Workflow decides lives here: where a new Step's rank falls, which Step a Task
 * resumes on, and whether finishing a Step moves the cursor. The DAL owns only *when* these are
 * asked — inside the transaction that writes the answer — for the same reason
 * `checkDependencyEdge` is separated from `addTaskDependencyEdge`: a rule that cannot be tested
 * without a database is a rule nobody re-reads.
 */

/**
 * The rank alphabet: base-62 whose ASCII order is its collation order, so `ORDER BY rank` under
 * SQLite's default BINARY collation *is* the Step order. Digits before uppercase before
 * lowercase is ASCII's own ordering — the alphabet is written out rather than derived so that a
 * future edit has to notice it is also a storage format.
 */
const RANK_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const RANK_BASE = RANK_DIGITS.length;

/**
 * No rank ever ends in the lowest digit. That invariant is what makes a missing character
 * comparable to `0` when the two ranks are of different lengths, and it is why every branch of
 * `rankBetween` below returns a non-zero final digit. Break it and mid-inserts stop terminating.
 */
const LOWEST_DIGIT = RANK_DIGITS[0] as string;

function digitAt(rank: string, index: number): number {
  return RANK_DIGITS.indexOf(rank[index] as string);
}

/**
 * A rank strictly between two neighbours — the whole of the ordering scheme (issue #5, the
 * parent's "an insert in the middle must not renumber every row").
 *
 * Ranks are lexicographic strings rather than integer positions because an integer position is a
 * statement about the whole list: inserting at position 3 of ten Steps rewrites seven rows, and
 * every one of those writes is a chance for two concurrent reorders to interleave into an order
 * neither caller asked for. A string midpoint touches exactly one row, and the row it touches is
 * the row being inserted.
 *
 * `before`/`after` are null at the ends of the list. Iterative rather than recursive: rank length
 * grows by roughly a character per insert into the same gap, so the depth is bounded by Owner
 * behaviour rather than by anything this module controls.
 */
export function rankBetween(
  before: string | null,
  after: string | null,
): Result<string, typeof WorkflowErrorCode.StaleOrder> {
  const lower = before ?? "";
  let upper = after;
  if (upper !== null && lower >= upper) return err(WorkflowErrorCode.StaleOrder);

  const out: string[] = [];
  let i = 0;

  // Copy the shared prefix. A missing character in `lower` reads as the lowest digit, which is
  // sound precisely because no rank ends in it.
  while (upper !== null && (lower[i] ?? LOWEST_DIGIT) === upper[i]) {
    out.push(upper[i] as string);
    i += 1;
  }
  // `upper` running out inside its own prefix would mean `lower` starts with it, i.e. the pair
  // is not in ascending order at all. The guard above already refused that, so this is a
  // corrupted rank rather than a caller mistake — refuse it the same way rather than loop.
  if (upper !== null && i >= upper.length) return err(WorkflowErrorCode.StaleOrder);

  for (;;) {
    const low = i < lower.length ? digitAt(lower, i) : 0;
    const high = upper !== null ? digitAt(upper, i) : RANK_BASE;
    if (high - low > 1) {
      out.push(RANK_DIGITS[Math.round((low + high) / 2)] as string);
      return ok(out.join(""));
    }
    // The two digits are adjacent, so nothing fits between them at this position. If `upper` has
    // more characters, taking its first one alone already lands below it; otherwise take
    // `lower`'s digit and keep descending, with `upper` no longer binding.
    if (upper !== null && upper.length > i + 1) {
      out.push(upper[i] as string);
      return ok(out.join(""));
    }
    out.push(RANK_DIGITS[low] as string);
    upper = null;
    i += 1;
  }
}

/** The rank of a Step appended to the end of a list — the ends stated as nulls, once. */
export function appendRank(lastRank: string | null): string {
  const next = rankBetween(lastRank, null);
  // Unreachable by construction: `rankBetween(x, null)` has no upper bound to conflict with.
  return next.ok ? next.data : LOWEST_DIGIT;
}

/** Anything with a rank. Steps are sorted by this and by nothing else. */
export interface RankedStep {
  id: string;
  rank: string;
}

/** Steps in pipeline order. Ties are impossible — `(workflow_id, rank)` is unique. */
export function sortSteps<T extends RankedStep>(steps: readonly T[]): readonly T[] {
  return [...steps].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
}

/**
 * The neighbours a move names, resolved against the list as it actually is.
 *
 * The pair has to be adjacent *now*. If it is not, the caller dragged a Step in a list somebody
 * else has since changed, and applying the move would place the Step somewhere neither of them
 * chose — so it is refused with `StaleOrder` and the caller re-reads (AC-1's editing half).
 */
export function rankForMove<T extends RankedStep>(
  steps: readonly T[],
  move: { stepId: string; afterStepId: string | null; beforeStepId: string | null },
): Result<string, WorkflowErrorCode> {
  const ordered = sortSteps(steps);
  if (!ordered.some((step) => step.id === move.stepId)) {
    return err(WorkflowErrorCode.StepNotInWorkflow);
  }
  // The moved Step is not its own neighbour, and it is not part of the list the neighbours are
  // checked against — otherwise moving a Step one place down would always look non-adjacent.
  const others = ordered.filter((step) => step.id !== move.stepId);
  const afterIndex = move.afterStepId
    ? others.findIndex((step) => step.id === move.afterStepId)
    : -1;
  const beforeIndex = move.beforeStepId
    ? others.findIndex((step) => step.id === move.beforeStepId)
    : others.length;
  if (move.afterStepId && afterIndex === -1) return err(WorkflowErrorCode.StepNotInWorkflow);
  if (move.beforeStepId && beforeIndex === -1) return err(WorkflowErrorCode.StepNotInWorkflow);
  if (beforeIndex !== afterIndex + 1) return err(WorkflowErrorCode.StaleOrder);

  const before = afterIndex >= 0 ? (others[afterIndex]?.rank ?? null) : null;
  const after = beforeIndex < others.length ? (others[beforeIndex]?.rank ?? null) : null;
  return rankBetween(before, after);
}

/**
 * Where a Task picks up (Principle III, AC-5).
 *
 * A null cursor is a Task that has not started its Workflow, so it starts at the first Step. A
 * cursor naming a Step that no longer exists is an *error* and never a silent restart: quietly
 * resuming at Step one would re-run work the Owner has already paid an agent for, and would do
 * it at the exact moment the operator is least able to notice.
 */
export function resumeWorkflowCursor<T extends RankedStep>(
  steps: readonly T[],
  cursorStepId: string | null,
): Result<T, WorkflowErrorCode> {
  const ordered = sortSteps(steps);
  const first = ordered[0];
  if (!first) return err(WorkflowErrorCode.Empty);
  if (cursorStepId === null) return ok(first);
  const current = ordered.find((step) => step.id === cursorStepId);
  return current ? ok(current) : err(WorkflowErrorCode.StepNotInWorkflow);
}

/** A Step, as much of it as the advance rules read. */
export interface WorkflowStepRule extends RankedStep {
  gate: WorkflowStepGate;
  advanceOn: WorkflowAdvanceOn;
}

/** What actually happened on the Step that just reported in. */
export interface WorkflowStepOutcome {
  /** Which signal arrived — an agent saying it is done, or a review landing. */
  signal: WorkflowAdvanceOn;
  /**
   * Did the Step leave changes behind? Read only by an `auto-unless-changes` gate.
   *
   * The caller reporting the Step finished is not the only source: the DAL ORs its claim with
   * what the server itself has recorded about the Task, because a party that says "I changed
   * nothing" is deciding whether the gate that exists to catch its output applies to it.
   */
  producedChanges: boolean;
  /**
   * Is there an *approval* for this Task that no earlier gate has already spent?
   *
   * Three words in that sentence are load-bearing, and each of them was a defect before it was a
   * requirement:
   *
   * - *approval* — the `review` table records refusals too. A `reject` is a human looking at the
   *   work and saying no; treating it as "a decision was recorded" would let the Workflow report
   *   itself finished on the strength of someone who explicitly stopped it.
   * - *unspent* — one approval releases one gate. Asking only "has this Task ever been decided
   *   on" degrades Principle I to "somebody looked at this Task once", so an approval of the plan
   *   would silently authorise the implementation and the final integration behind it.
   * - *this Task* — the DAL scopes the lookup by Workspace and by Task; see `latestDecisionForTask`.
   *
   * Sourced from the database and from the Task's own record of what it has already spent, never
   * from a caller.
   */
  unspentApproval: boolean;
}

export interface WorkflowAdvance {
  status: WorkflowAdvanceStatus;
  /** The Step the Task is on afterwards — the same one unless the status is `advanced`. */
  stepId: string;
  /**
   * Did this move rest on the approval? The DAL marks that approval spent when it did, which is
   * what stops the same one from releasing every remaining gate. `auto` moves consume nothing,
   * so a pipeline of `auto` Steps still costs exactly one human decision — at the end.
   */
  consumedApproval: boolean;
}

/** Does this Step's gate require a human's approval, given what happened on it? */
function gateNeedsApproval(gate: WorkflowStepGate, outcome: WorkflowStepOutcome): boolean {
  if (gate === "auto") return false;
  if (gate === "auto-unless-changes") return outcome.producedChanges;
  return true;
}

/**
 * What finishing a Step does to the cursor (AC-2, AC-4).
 *
 * The last Step is where Principle I lives, and it is deliberately the one branch that does not
 * consult the gate at all. A Workflow whose Steps are every one of them `auto` still cannot
 * reach `completed` without a recorded human decision, because "the Owner configured it that
 * way" is not a decision about *this* change — it is a decision about every future change at
 * once, which is precisely what Principle I refuses. An `auto` gate buys a Task the right to
 * move between Steps without a human; it never buys the right to finish without one.
 *
 * `held` rather than an error when the signal is not the one the Step advances on: a review
 * landing on a Step that advances on the agent's own signal is ordinary, not a fault.
 *
 * Every branch that leans on the approval says so in `consumedApproval`, so the caller can mark
 * it spent. Without that, one approval opens every gate the Task has left — which is the same
 * bypass as configuring the whole pipeline `auto`, arrived at from the other direction.
 */
export function advanceWorkflowStep(
  steps: readonly WorkflowStepRule[],
  currentStepId: string,
  outcome: WorkflowStepOutcome,
): Result<WorkflowAdvance, WorkflowErrorCode> {
  const ordered = sortSteps(steps);
  const index = ordered.findIndex((step) => step.id === currentStepId);
  const current = ordered[index];
  if (!current) return err(WorkflowErrorCode.StepNotInWorkflow);

  if (outcome.signal !== current.advanceOn) {
    return ok({ status: "held", stepId: current.id, consumedApproval: false });
  }

  const next = ordered[index + 1];
  if (!next) {
    return ok(
      outcome.unspentApproval
        ? { status: "completed", stepId: current.id, consumedApproval: true }
        : { status: "awaiting-decision", stepId: current.id, consumedApproval: false },
    );
  }

  const needsApproval = gateNeedsApproval(current.gate, outcome);
  if (needsApproval && !outcome.unspentApproval) {
    return ok({ status: "awaiting-decision", stepId: current.id, consumedApproval: false });
  }
  return ok({ status: "advanced", stepId: next.id, consumedApproval: needsApproval });
}

/** The heading the handoff is carried under. One constant so the brief reads the same every run. */
const HANDOFF_HEADING = "## Handed over from the previous step";

/**
 * The prompt the current Step's agent is actually given (AC-2's "carrying the handoff context",
 * issue #82).
 *
 * Built here rather than in the runner so that the API, the UI's preview and whatever eventually
 * spawns the agent all read one string. The handoff leads because it is the context the template
 * is written against — a template that says "review the plan" is unusable if the plan arrives
 * underneath it.
 */
export function buildStepBrief(step: { promptTemplate: string }, handoff: string | null): string {
  const template = step.promptTemplate.trim();
  const carried = handoff?.trim();
  if (!carried) return template;
  return `${HANDOFF_HEADING}\n\n${carried}\n\n${template}`.trim();
}
