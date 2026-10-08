import type { TaskState } from "@solow/contracts";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
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
        .set({ state: "running", failureReason: null, updatedAt: new Date().toISOString() })
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
