import type { TaskState } from "@solow/contracts";
import { and, count, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./index.js";
import { harnessProfile, task } from "./schema.js";

/**
 * Take a Harness Profile concurrency slot for a Task (spec F06 FR-6, FINDINGS F5).
 *
 * In `@solow/db` for `workflow-run.ts`'s reason: both apps move a Task into `running` — the web
 * app when a person starts one, the orchestrator when a run parked on a quota window wakes — and
 * the rule that decides whether there is room is one rule. A second copy in the orchestrator would
 * be a second cap that drifts from the first.
 *
 * A slot is a live Task of the Profile reading `running` — the row itself, not a counter beside
 * it — so there is nothing to release: every way out of `running` (the review gate, parked,
 * failed, done, ready again, History) gives the slot back by being that write, and no path can
 * forget to. The count and the cap are subqueries of the UPDATE that takes the row, so the write
 * that fills the last slot is the one every later write's count already includes; a count read
 * first and compared in JavaScript let N simultaneous starts all see room for one more.
 *
 * One `running` row holds no slot: a Task on no Workflow whose harness has finished. Its run
 * ended at `to-review` and released its executor (ADR 0030), but the Task stays `running` until
 * a person opens the review — that move is theirs, not the run's (`finishRound`). Counted, it
 * held a slot for as long as nobody looked, and N finished Tasks refused every start on a cap of
 * N, for a limit that is about harness spend. `completed_at` is what `to-review` writes, so that
 * write is the release, the same way every other release is the write that ends the run.
 *
 * Only on no Workflow, because only there is `to-review` the run's last step. Under a Workflow
 * it records the declaration before the Step's rule decides whether the cursor moves, and an
 * advance runs the next Step's harness in the same run: releasing there would let another start
 * take the slot in between. So a Task on a Workflow that ends `blocked` still counts until it
 * leaves `running`, as does a Task with a Workflow attached in a Workspace with Workflows off.
 * Both err towards the cap.
 *
 * The claim clears `completed_at` in the same write, so a start counts from the moment it takes
 * the row: a Retry of a Task that kept an earlier run's declaration, or a decision sending one
 * back to work, would otherwise run its harness uncounted until it declared again. Only the
 * timestamp: the run a decision starts reads the declaration itself (`applyDecision`) and clears
 * it once it has moved on. A caller that rolls a claim back restores the timestamp, because a
 * gate put back without it would no longer show what the harness declared.
 *
 * `BEGIN IMMEDIATE` is for the read of the Task's Profile and the verdict on a loss: it takes
 * SQLite's write lock up front, so the other process sharing the file cannot move the row between
 * that read and the claim.
 */

type TaskRow = typeof task.$inferSelect;

export type TaskRunClaim =
  | { kind: "claimed"; row: TaskRow }
  | { kind: "missing" }
  /** Still in one of `from`: the Profile had no slot left. */
  | { kind: "cap_reached" }
  /** Another start, or the run itself, moved the row first. */
  | { kind: "moved"; state: TaskState };

export function claimTaskRunSlot(
  db: Db,
  workspaceId: string,
  taskId: string,
  from: readonly TaskState[],
): TaskRunClaim {
  return db.transaction(
    (tx): TaskRunClaim => {
      const [current] = tx
        .select({ state: task.state, agentProfileId: task.agentProfileId })
        .from(task)
        .where(and(eq(task.workspaceId, workspaceId), eq(task.id, taskId), isNull(task.deletedAt)))
        .limit(1)
        .all();
      if (!current) return { kind: "missing" };

      const holding = tx
        .select({ n: count() })
        .from(task)
        .where(
          and(
            eq(task.workspaceId, workspaceId),
            eq(task.agentProfileId, current.agentProfileId),
            eq(task.state, "running"),
            isNull(task.deletedAt),
            // Not a finished Task on no Workflow: see the comment at the top.
            or(isNotNull(task.workflowId), isNull(task.completedAt)),
          ),
        );
      const cap = tx
        .select({ cap: harnessProfile.concurrencyCap })
        .from(harnessProfile)
        .where(
          and(
            eq(harnessProfile.workspaceId, workspaceId),
            eq(harnessProfile.id, current.agentProfileId),
          ),
        );
      const [row] = tx
        .update(task)
        .set({
          state: "running",
          failureReason: null,
          completedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(task.workspaceId, workspaceId),
            eq(task.id, taskId),
            inArray(task.state, [...from]),
            sql`(${holding}) < (${cap})`,
          ),
        )
        .returning()
        .all();
      if (row) return { kind: "claimed", row };
      return from.includes(current.state)
        ? { kind: "cap_reached" }
        : { kind: "moved", state: current.state };
    },
    { behavior: "immediate" },
  );
}
