import {
  err,
  ok,
  type Result,
  type WorkflowAdvanceOn,
  type WorkflowAdvanceStatus,
  WorkflowErrorCode,
  type WorkflowStepBranch,
  type WorkflowStepCondition,
  type WorkflowStepGate,
} from "@solow/contracts";

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
 * resuming at Step one would re-run work the Owner has already paid a harness for, and would do
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
  /** Where the Step sends the Task, if not to its rank successor. Absent and null read alike. */
  branch?: WorkflowStepBranch | null;
}

/** What actually happened on the Step that just reported in. */
export interface WorkflowStepOutcome {
  /** Which signal arrived — a harness saying it is done, or a review landing. */
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
  /**
   * Was this Task's recorded decision spent by *this very* approval — i.e. is this a replay?
   *
   * The cursor is the replay guard everywhere else: an `advanced` outcome moves it, so a
   * re-executed step body names a Step the Task has left and the caller refuses it as stale. The
   * terminal Step has nowhere to move the cursor to, so that guard is silent exactly where the
   * run integrates, and the second pass reads a world the first pass changed — the approval it
   * needs is the one it just marked spent. Verified against a real transaction: an identical call
   * repeated returns `completed` and then `awaiting-decision`, and the run exits before it
   * commits anything, leaving the Task waiting on a decision the operator has already given.
   *
   * This says "the decision on record is this same approval, already spent here", which is a
   * replay and not a second gate. It cannot launder one approval into two: a `request-changes`
   * makes the latest decision something other than an approval, and a fresh approval writes a new
   * row whose id differs from the spent one — so both of those take the ordinary path.
   */
  approvalAlreadySpent: boolean;
  /**
   * What the Step reported — the summary the next Step is briefed with, and where a harness's
   * answer to an `agent-decides` question is read from. Null when the Step said nothing, which
   * no answer can be found in.
   */
  handoff: string | null;
}

/**
 * The line a harness answers a branch question on. One constant, used to *ask* (in the brief)
 * and to *read* (off the handoff), so the two cannot drift into asking for one thing and
 * looking for another.
 */
export const DECISION_MARKER = "DECISION:";

/**
 * The harness's answer to its Step's question, or null when it gave none.
 *
 * The *last* `DECISION:` line wins: a harness that reasons its way to an answer may write the
 * word more than once, and the one it finished on is the one it meant. Case-insensitive on both
 * the marker and the word — `Decision: Yes` is an answer, not a typo — and anchored to a line so
 * a sentence *about* the decision ("the DECISION: yes/no format …") is not read as one.
 */
export function readHarnessDecision(handoff: string | null): "yes" | "no" | null {
  if (!handoff) return null;
  let answer: "yes" | "no" | null = null;
  for (const line of handoff.split(/\r?\n/)) {
    const match = /^\s*DECISION:\s*(yes|no)\b/i.exec(line);
    if (match) answer = match[1]?.toLowerCase() === "yes" ? "yes" : "no";
  }
  return answer;
}

/**
 * The summary the next Step is briefed with, with the harness's answer in it.
 *
 * Measured on the first live run: the reviewer wrote `DECISION: no` exactly as asked — at the
 * end of its final message — and reported through its `task_complete` widget with a summary
 * that did not repeat it. The summary is what travels as the handoff, so the answer was lost and
 * the branch fell back to "no answer". A harness's final message is as much its report as the
 * widget's summary, so an answer found there is carried over when the summary has none. The
 * summary's own line wins when both exist: it was written last, as the report of record.
 */
export function carryHarnessDecision(
  summary: string | null,
  finalText: string | null,
): string | null {
  if (readHarnessDecision(summary) !== null) return summary;
  const answer = readHarnessDecision(finalText);
  if (answer === null) return summary;
  const line = `${DECISION_MARKER} ${answer}`;
  return summary ? `${summary.trimEnd()}\n\n${line}` : line;
}

/**
 * Is the branch's condition true of what just happened?
 *
 * Both questions are answered from the outcome alone, which is what keeps a Condition from
 * becoming a second rules engine: nothing here is fetched, and the facts consulted are the ones
 * the advance already had in hand for the gate. For `agent-decides` the fact is the harness's own
 * answer; a harness that did not answer has not affirmed the condition, so the `no` branch is
 * taken — the brief says so, and a silent default the harness was not told about would be a rule
 * nobody wrote.
 */
export function evaluateStepCondition(
  condition: WorkflowStepCondition,
  outcome: Pick<WorkflowStepOutcome, "handoff" | "producedChanges">,
): boolean {
  switch (condition.kind) {
    case "agent-decides":
      return readHarnessDecision(outcome.handoff) === "yes";
    case "produced-changes":
      return outcome.producedChanges;
  }
}

/** One way out of a Step. `stepId` null is the end of the pipeline. */
export interface WorkflowStepExit {
  /** `next` is the rank successor, the only exit an unbranched Step has; `then`/`else` are a branch's two. */
  kind: "next" | "then" | "else";
  stepId: string | null;
}

/** A Step with the two fields the graph is built from. */
export interface WorkflowGraphStep extends RankedStep {
  branch?: WorkflowStepBranch | null;
}

/**
 * Where each Step can send the Task — the whole graph, stated once.
 *
 * This is the rule `advanceWorkflowStep` applies at run time, read off the definition instead
 * of the outcome: a Step without a branch has exactly one exit, to its rank successor or to the
 * end; a Step with one has exactly two. There is no other kind of edge, which is why the
 * designer's one connect gesture only re-points a branch exit — an edge that is not one of
 * these is not something the run loop could ever follow.
 */
export function stepExits<T extends WorkflowGraphStep>(
  steps: readonly T[],
): Map<string, WorkflowStepExit[]> {
  const ordered = sortSteps(steps);
  const exits = new Map<string, WorkflowStepExit[]>();
  ordered.forEach((step, index) => {
    exits.set(
      step.id,
      step.branch
        ? [
            { kind: "then", stepId: step.branch.thenStepId },
            { kind: "else", stepId: step.branch.elseStepId },
          ]
        : [{ kind: "next", stepId: ordered[index + 1]?.id ?? null }],
    );
  });
  return exits;
}

/**
 * A shape the graph must not have (F03 FR-5).
 *
 * - `unreachable`: nothing leads to the Step, so it never runs. The start is the first Step in
 *   rank order, and a branch that skips over a Step whose predecessor also branches past it
 *   leaves it with no way in.
 * - `no-exit`: from this Step the end can never be reached — every path loops. A Task that got
 *   here would run until the round budget stopped it, and never finish.
 */
export interface WorkflowGraphProblem {
  kind: "unreachable" | "no-exit";
  stepId: string;
}

/**
 * Everything that is wrong with the graph, or nothing.
 *
 * Reachability both ways: forward from the start over `stepExits`, and backward from the end
 * over the same edges reversed. Two walks rather than one clever one, because the two questions
 * are different — "can this Step run" and "can a Task that ran it finish" — and a Step can fail
 * either alone. An empty Workflow has no problems here; that it cannot be attached is
 * `WorkflowErrorCode.Empty`'s to say.
 *
 * Reported, not refused, at edit time: a designer that refused an unreachable Step could not be
 * used to build the loop that makes it reachable again. The refusal is at `attachTask`.
 */
export function validateWorkflowGraph<T extends WorkflowGraphStep>(
  steps: readonly T[],
): WorkflowGraphProblem[] {
  const ordered = sortSteps(steps);
  const start = ordered[0];
  if (!start) return [];
  const exits = stepExits(ordered);

  const reachable = new Set<string>();
  const forward = [start.id];
  while (forward.length > 0) {
    const id = forward.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const exit of exits.get(id) ?? []) {
      if (exit.stepId !== null && !reachable.has(exit.stepId)) forward.push(exit.stepId);
    }
  }

  // Which Steps lead into each Step, and which lead straight to the end.
  const into = new Map<string, string[]>();
  const ending: string[] = [];
  for (const [id, stepExitList] of exits) {
    for (const exit of stepExitList) {
      if (exit.stepId === null) ending.push(id);
      else into.set(exit.stepId, [...(into.get(exit.stepId) ?? []), id]);
    }
  }
  const finishing = new Set<string>();
  const backward = [...ending];
  while (backward.length > 0) {
    const id = backward.pop() as string;
    if (finishing.has(id)) continue;
    finishing.add(id);
    for (const from of into.get(id) ?? []) if (!finishing.has(from)) backward.push(from);
  }

  return ordered.flatMap((step): WorkflowGraphProblem[] => [
    ...(reachable.has(step.id) ? [] : [{ kind: "unreachable" as const, stepId: step.id }]),
    ...(finishing.has(step.id) ? [] : [{ kind: "no-exit" as const, stepId: step.id }]),
  ]);
}

export interface WorkflowAdvance {
  status: WorkflowAdvanceStatus;
  /** The Step the Task is on afterwards — the same one unless the status is `advanced`. */
  stepId: string;
  /**
   * Did this move rest on the approval? The DAL marks that approval spent when it did, which is
   * what stops the same one from releasing every remaining gate. `auto` moves consume nothing,
   * so a pipeline of `auto` Steps still costs exactly one human decision — at the end.
   *
   * "Rest on" includes a move a human *triggered* even where the gate asked for nothing, and
   * that distinction was a Principle I hole reachable by configuration alone: Step 1 `gate: "auto"`
   * with `advanceOn: "review"`, a last Step with `advanceOn: "agent-signal"`. A reviewer approves
   * the *plan*; the advance needs no approval, so on the narrow reading nothing is spent; the last
   * Step's harness then signals, finds that same approval unspent, and the implementation is
   * integrated with nobody having seen its diff. An approval buys the move it caused and no other.
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
 * landing on a Step that advances on the harness's own signal is ordinary, not a fault.
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

  // The rank successor unless the Step branches, in which case the condition picks the target.
  // A null target is "the pipeline ends here", and it lands in the same terminal rule as running
  // off the end of the list — which is what keeps Principle I in one place.
  let next: WorkflowStepRule | undefined;
  if (current.branch) {
    const targetId = evaluateStepCondition(current.branch.when, outcome)
      ? current.branch.thenStepId
      : current.branch.elseStepId;
    if (targetId !== null) {
      next = ordered.find((step) => step.id === targetId);
      // The DAL refuses a branch to a Step outside the Workflow, so this is a Step deleted since
      // — refused by name, for the reason `resumeWorkflowCursor` refuses a dangling cursor.
      if (!next) return err(WorkflowErrorCode.StepNotInWorkflow);
    }
  } else {
    next = ordered[index + 1];
  }
  if (!next) {
    if (outcome.unspentApproval) {
      return ok({ status: "completed", stepId: current.id, consumedApproval: true });
    }
    // The replay. `consumedApproval` is false because the first pass already spent it — saying
    // true would rewrite the same id over itself, which is harmless but claims a second spend
    // that never happened. This branch is why the terminal Step is safe to re-execute at all:
    // see `approvalAlreadySpent`.
    if (outcome.approvalAlreadySpent) {
      return ok({ status: "completed", stepId: current.id, consumedApproval: false });
    }
    return ok({ status: "awaiting-decision", stepId: current.id, consumedApproval: false });
  }

  const needsApproval = gateNeedsApproval(current.gate, outcome);
  if (needsApproval && !outcome.unspentApproval) {
    return ok({ status: "awaiting-decision", stepId: current.id, consumedApproval: false });
  }
  // A move a human's approval *triggered* spends that approval, whatever the gate thought it
  // needed. Without the second clause an approval that released nothing is never marked spent,
  // and it is still on offer at the last Step — where Principle I asks for one.
  return ok({
    status: "advanced",
    stepId: next.id,
    consumedApproval: needsApproval || (outcome.signal === "review" && outcome.unspentApproval),
  });
}

/** The heading the handoff is carried under. One constant so the brief reads the same every run. */
const HANDOFF_HEADING = "## Handed over from the previous step";

/** The heading the branch question is asked under. */
const DECISION_HEADING = "## Decision to make";

/** A Step, as much of it as the brief reads. */
export interface WorkflowStepBriefSource {
  promptTemplate: string;
  branch?: WorkflowStepBranch | null;
}

/**
 * The prompt the current Step's harness is actually given (AC-2's "carrying the handoff context",
 * issue #82).
 *
 * Built here rather than in the runner so that the API, the UI's preview and whatever eventually
 * spawns the harness all read one string. The handoff leads because it is the context the template
 * is written against — a template that says "review the plan" is unusable if the plan arrives
 * underneath it.
 *
 * A Step whose branch is decided by the harness has the question appended, with the exact line to
 * answer on and what each answer leads to. Appended by *this* function rather than typed into
 * the template by the operator, so the question the harness is asked is the one the branch will
 * read — and so the marker the harness is told to write is `DECISION_MARKER`, not a paraphrase of
 * it. `steps` is what the two targets are named from; a target outside it, or null, is named as
 * the end of the pipeline.
 */
export function buildStepBrief(
  step: WorkflowStepBriefSource,
  handoff: string | null,
  steps: readonly { id: string; name: string }[] = [],
): string {
  const template = step.promptTemplate.trim();
  const carried = handoff?.trim();
  const parts = carried ? [HANDOFF_HEADING, carried, template] : [template];

  const branch = step.branch;
  if (branch?.when.kind === "agent-decides") {
    const nameOf = (id: string | null) =>
      (id !== null && steps.find((s) => s.id === id)?.name) || null;
    const then = nameOf(branch.thenStepId);
    const otherwise = nameOf(branch.elseStepId);
    const leads = (name: string | null) =>
      name ? `the pipeline continues with "${name}"` : "the pipeline ends";
    parts.push(
      DECISION_HEADING,
      [
        `Before you finish, decide: ${branch.when.question.trim()}`,
        `Answer on a line of its own, exactly \`${DECISION_MARKER} yes\` or \`${DECISION_MARKER} no\`, at the end of your final message — and in your closing summary too, if you write one.`,
        `If yes, ${leads(then)}; if no, ${leads(otherwise)}. No answer counts as no.`,
      ].join("\n"),
    );
  }
  return parts
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}
