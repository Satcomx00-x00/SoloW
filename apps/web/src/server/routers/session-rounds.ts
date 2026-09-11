import {
  type ReviewDto,
  type SessionRoundDto,
  type TaskDiffDto,
  taskDiffDto,
} from "@solow/contracts";

/** The two fields of a log row this module reads; the DAL's row type is wider. */
interface LogRow {
  seq: number;
  kind: string;
  payload: unknown;
}

/**
 * The diff the orchestrator captured at the review gate, pulled back out of the event log.
 *
 * Stored as a `diff` session event rather than a column: it arrives on the same append-only log
 * as everything else the run produced, so it replays with the rest and survives the worktree
 * being torn down. Still parsed rather than trusted even though the payload is now typed — a
 * `diff` row written before the union existed reaches this function through the compatibility
 * mapping, and a shape that no longer matches degrades to "no diff" instead of breaking the
 * review page. `taskDiffDto` is non-strict, so the payload's own `kind` key is simply dropped.
 */
export function latestDiffPerRepository(
  events: ReadonlyArray<{ kind: string; payload: unknown }>,
  attachmentOrder: readonly string[],
): TaskDiffDto[] {
  // Keyed on the repository so a later review round replaces that repository's group rather
  // than appending a second one; an event written before multi-repository Tasks existed carries
  // no repository and shares the empty key, which is exactly the old "latest diff" behaviour.
  const byRepository = new Map<string, TaskDiffDto>();
  for (const event of events) {
    if (event.kind !== "diff") continue;
    const parsed = taskDiffDto.safeParse(event.payload);
    if (!parsed.success) continue;
    byRepository.set(parsed.data.repositoryId ?? "", parsed.data);
  }

  // A log can hold both shapes at once: a Task sitting at the review gate across an orchestrator
  // upgrade keeps the memoized legacy capture from the round before it and gains a named one
  // from the round after. The unlabelled entry is then a superseded copy of a capture that now
  // has a name, so it is dropped rather than shown beside it as a second, stale group — a Task
  // that only ever had one repository must not grow an "Unnamed repository" section. It survives
  // only when nothing in the log is named at all, which is the pre-#7 Session this exists for.
  if (byRepository.size > 1) byRepository.delete("");

  // Ordered by attachment position, not by which repository the orchestrator happened to capture
  // first: each capture is wrapped in its own try/catch, so a round where the primary's capture
  // failed and a secondary's succeeded would otherwise put the secondary first — and `diff`,
  // which every legacy consumer reads as "the primary Repository's change", is `diffs[0]`.
  const rank = new Map(attachmentOrder.map((id, index) => [id, index]));
  const unknown = attachmentOrder.length;
  return [...byRepository.values()]
    .map((diff, index) => ({ diff, index, rank: rank.get(diff.repositoryId ?? "") ?? unknown }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.diff);
}

/**
 * The Session's review rounds, read back out of its log (F10 FR-7).
 *
 * The orchestrator keeps one Session across every round — request-changes resumes it rather
 * than opening another — so rounds are not rows anywhere. What the log does record is the Task
 * *leaving* review: `recordTransition("review", …)` on approve, reject, request-changes and a
 * Workflow Step advancing. Each such `state` event closes a round, and the round's change is
 * whatever the latest capture per Repository was by then. Entering review is a human move
 * (`task.submitForReview`) and leaves no reliable event, which is why the boundary is the exit.
 *
 * Reviews are paired to closed rounds in order: the i-th decision recorded is the i-th round's.
 * A round with no review paired (a Step advance that skipped the gate, or a decision recorded
 * against a run that was already gone) is returned with `review: null` rather than borrowing the
 * next one. The open tail — captures since the last exit — is a round of its own when it has
 * any, which is the Session sitting at its gate now.
 */
export function sessionRounds(
  events: readonly LogRow[],
  reviews: readonly ReviewDto[],
  attachmentOrder: readonly string[],
): SessionRoundDto[] {
  const rounds: SessionRoundDto[] = [];
  // Exits from review seen so far — the pairing index into `reviews`. Counted separately from
  // `rounds` because an exit with nothing ever captured is not a round anyone reviewed (a Task
  // moved out of Review by hand before the harness got anywhere) and is skipped, while the
  // decision that may have been recorded for it is still consumed so later pairings stay aligned.
  let exits = 0;
  let from = 0;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event?.kind !== "state") continue;
    const payload = event.payload as { from?: unknown } | null;
    if (payload?.from !== "review") continue;
    const diffs = latestDiffPerRepository(events.slice(0, i + 1), attachmentOrder);
    const review = reviews[exits] ?? null;
    exits += 1;
    from = i + 1;
    if (diffs.length === 0) continue;
    rounds.push({ index: rounds.length + 1, closedAtSeq: event.seq, diffs, review });
  }
  const tail = latestDiffPerRepository(events, attachmentOrder);
  // The open round: only when something was captured *after* the last exit, otherwise the last
  // closed round's change would be shown twice — once closed, once "open".
  const capturedSince = events.slice(from).some((e) => e.kind === "diff");
  if (tail.length > 0 && (capturedSince || rounds.length === 0)) {
    rounds.push({
      index: rounds.length + 1,
      closedAtSeq: null,
      diffs: tail,
      review: reviews[exits] ?? null,
    });
  }
  return rounds;
}
