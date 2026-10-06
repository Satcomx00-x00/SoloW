import type { DecisionWidget } from "@solow/contracts";

/**
 * The decisions a review gate is about: the ones asked in the round it would close.
 *
 * Not every decision in the Session. A Step that already moved on had its decisions answered at
 * its own gate, and an approval with answers sends them back to the same Step's harness for one
 * more round before the Workflow moves on — so at the next gate, the decisions of earlier rounds
 * are a record, not a question. Counting them made a finished Step read "Confirm AI decisions
 * 0/1" under the next Step's gate, inflated the gate's count, and would send the same answers
 * round again on every approval, which on a last Step never ends.
 *
 * A round never spans two Steps (the cursor only moves at a gate), so "asked after the previous
 * round closed" is also "asked on this Step, this pass". A decision whose position is unknown
 * stays in: asking once too often is the safe mistake.
 */
export function gateDecisions(
  decisions: readonly DecisionWidget[],
  origin: ReadonlyMap<string, { sessionId: string; seq: number }>,
  sessionId: string | null,
  rounds: readonly { closedAtSeq: number | null }[],
): DecisionWidget[] {
  const openedAfter = rounds.length > 1 ? (rounds[rounds.length - 2]?.closedAtSeq ?? -1) : -1;
  return decisions.filter((widget) => {
    const at = origin.get(`decision:${widget.id}`);
    if (!at) return true;
    return at.sessionId === sessionId && at.seq > openedAfter;
  });
}
