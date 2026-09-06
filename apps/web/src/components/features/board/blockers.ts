import type { TaskDependencyDto, TaskState } from "@solow/contracts";
import { canTransitionTask } from "@solow/core";
import { STATE_LABELS } from "@/lib/task-states";

/**
 * How a blocked Task is explained to the Owner (issue #6).
 *
 * Its own module rather than a helper inside `board.tsx` because the card renders the same
 * sentence and importing it from the board would close a cycle — the board is what renders the
 * card. One wording, three call sites, no cycle.
 */

/** "Waiting on X (Running), Y (Backlog)" — the one sentence that says what is outstanding. */
export function waitingOn(outstanding: readonly TaskDependencyDto[]): string {
  return `Waiting on ${outstanding
    .map((edge) => `${edge.blockedByTitle} (${STATE_LABELS[edge.blockedByState]})`)
    .join(", ")}`;
}

/**
 * Why a drag would be refused, as a sentence — or null when it would be allowed.
 *
 * The dependency half is not decoration over the server's answer: without it the drag path is
 * the one way into `running` that skips the disabled-Launch affordance entirely, so the Owner
 * gets the wire code `TASK_BLOCKED` in a banner while the illegal-transition case standing right
 * beside it gets a human sentence. Both refusals are decided here, in the same shape.
 */
export function moveRefusal(
  from: TaskState,
  to: TaskState,
  outstanding: readonly TaskDependencyDto[],
): string | null {
  if (!canTransitionTask(from, to).ok) {
    return `Can't move ${STATE_LABELS[from]} → ${STATE_LABELS[to]}`;
  }
  // Only the move *into* running is a start; the server refuses it either way (`requireUnblocked`).
  if (to === "running" && outstanding.length > 0) {
    return `Can't start this task yet. ${waitingOn(outstanding)}`;
  }
  return null;
}

/**
 * Why a card cannot be dragged onto a Workflow Step column (issue #5).
 *
 * This is the only place the product explains why a pipeline does not move by hand, so it says
 * what *does* move it rather than only refusing. A drop that wrote `task.workflow_step_id`
 * directly would skip the Step's gate, spend no approval, promote no handoff and record no
 * decision — a Principle I bypass arrived at by gesture — so Step columns register no drop
 * target at all and this sentence is what the operator gets instead.
 *
 * Separate from `moveRefusal`, which knows about lifecycle transitions and dependency edges and
 * is given no gate knowledge: the two refusals are about different things and a single function
 * answering both would have to be told which board it was on.
 */
export function stepMoveRefusal(): string {
  return "Steps advance when the step's gate is satisfied — approve the review to move this on.";
}
