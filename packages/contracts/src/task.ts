import { z } from "zod";
import { idSchema, taskStateSchema, timestampsSchema } from "./common.js";
import { gitRefNameSchema } from "./repository.js";

/**
 * How many Repositories one Task may span (issue #7). A ceiling rather than a limit anyone is
 * expected to reach: a Task touching a dozen repositories has stopped being one unit of review,
 * which is what Principle I asks a Task to be. It exists so a malformed or hostile input cannot
 * ask the orchestrator to provision an unbounded number of worktrees.
 */
export const MAX_TASK_REPOSITORIES = 10;

/**
 * One Repository a Task works in, with the branch it works on (issue #7).
 *
 * The pair — not the Repository alone — is the identity. Keying on `(repository, branch)` is
 * what makes "one Task, two branches of the same Repository" a row rather than a second
 * migration, and it costs nothing to state now while every Task still attaches one Repository.
 *
 * `checkoutBranch` may be omitted, in which case the server derives the deterministic name
 * `taskCheckoutBranch` produces. It is never stored null: SQLite treats every NULL as distinct,
 * so a nullable branch would make the `(task, repository, branch)` unique index enforce nothing
 * at all, and "which worktree is this Task's" would be answered by insertion order.
 */
export const taskRepositoryInput = z.object({
  repositoryId: idSchema,
  /** Base branch/commit the worktree starts from; `null` on the row means HEAD. */
  baseRef: gitRefNameSchema.optional(),
  /** The branch this attachment's worktree sits on; derived server-side when omitted. */
  checkoutBranch: gitRefNameSchema.optional(),
});
export type TaskRepositoryInput = z.infer<typeof taskRepositoryInput>;

/**
 * The deterministic branch a Task's worktree sits on when the Owner named none (issue #7).
 *
 * It lives in the contract rather than beside the worktree manager because the contract is the
 * first thing that needs it: `setTaskRepositoriesInput` cannot tell an Owner that two of its
 * entries are the same attachment without deriving the name the omitted half will be given.
 * `@gatecontrol/core` re-exports it, so the DAL, the manager and the migration still read one
 * template rather than three copies of it.
 */
export function taskCheckoutBranch(taskId: string): string {
  return `gatecontrol/task-${taskId}`;
}

/**
 * The entries whose `(repository, branch)` pair an earlier entry already claimed.
 *
 * `resolveBranch` is a parameter because what an omitted `checkoutBranch` resolves to depends on
 * the Task id. `task.create` has none yet — two entries that both omit the branch still collide,
 * but nothing can name the derived branch of a Task that does not exist — while
 * `task.setRepositories` does, and there an entry spelling the derived name out is the very same
 * attachment as one that omits it. Comparing those as two different keys is what let a duplicate
 * reach the unique index, where the refusal arrived as a raw database error with nothing in it
 * to tell the caller which entry was at fault.
 *
 * The separator is written as an escape rather than as the byte itself: a literal NUL in the
 * source makes git classify this file as binary, and a contract nobody can diff, blame or merge
 * is a worse problem than the one the separator solves.
 */
function duplicateEntryIndexes(
  entries: readonly TaskRepositoryInput[],
  resolveBranch: (entry: TaskRepositoryInput) => string,
): number[] {
  const seen = new Set<string>();
  const duplicates: number[] = [];
  entries.forEach((entry, index) => {
    const key = `${entry.repositoryId}\u0000${resolveBranch(entry)}`;
    if (seen.has(key)) duplicates.push(index);
    seen.add(key);
  });
  return duplicates;
}

const DUPLICATE_ATTACHMENT_MESSAGE = "the same repository and branch is attached twice";

/**
 * The whole attachment list, refusing a duplicate `(repositoryId, checkoutBranch)` pair before
 * the database has to. Two entries naming the same repository with no explicit branch would both
 * derive the same name, so the omitted case is compared as the same key rather than as two
 * unknowns — otherwise the refusal would only arrive as a unique-index failure at write time,
 * with nothing to tell the caller which entry was the duplicate.
 */
const taskRepositoriesSchema = z
  .array(taskRepositoryInput)
  .min(1)
  .max(MAX_TASK_REPOSITORIES)
  .superRefine((entries, ctx) => {
    for (const index of duplicateEntryIndexes(entries, (entry) => entry.checkoutBranch ?? "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "repositoryId"],
        message: DUPLICATE_ATTACHMENT_MESSAGE,
      });
    }
  });

export const createTaskInput = z.object({
  issueId: idSchema,
  title: z.string().min(1).max(200),
  agentProfileId: idSchema,
  executorProfileId: idSchema,
  /** One or more Repositories the Task works in, most important first (issue #7 AC-1). */
  repositories: taskRepositoriesSchema,
});
export type CreateTaskInput = z.infer<typeof createTaskInput>;

/**
 * Replace a Task's whole attachment set (issue #7 AC-1).
 *
 * The whole list is sent, not a delta, for the reason `updateRepositorySetupInput` gives: a
 * partial update makes "which repositories does this Task touch right now" a question about
 * ordering rather than about the stored value. Refused once the Task has left `backlog`/`ready`,
 * because re-pointing a Task whose worktrees are already live would orphan them (Principle II).
 */
export const setTaskRepositoriesInput = z
  .object({
    taskId: idSchema,
    repositories: taskRepositoriesSchema,
  })
  // Checked a second time with the Task id in hand, because only this side of the parse knows
  // what an omitted branch derives to: `[{ repo }, { repo, checkoutBranch: <derived> }]` is one
  // attachment written two ways. Without this the pair reached the unique index and the Owner
  // got an INTERNAL_SERVER_ERROR carrying SQLite's constraint text instead of a refusal naming
  // the entry — which is precisely what the list-level check above exists to prevent.
  .superRefine((input, ctx) => {
    const derived = taskCheckoutBranch(input.taskId);
    const duplicates = duplicateEntryIndexes(
      input.repositories,
      (entry) => entry.checkoutBranch ?? derived,
    );
    for (const index of duplicates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repositories", index, "repositoryId"],
        message: DUPLICATE_ATTACHMENT_MESSAGE,
      });
    }
  });
export type SetTaskRepositoriesInput = z.infer<typeof setTaskRepositoriesInput>;

export const launchTaskInput = z.object({ id: idSchema });
export type LaunchTaskInput = z.infer<typeof launchTaskInput>;

export const moveTaskInput = z.object({
  id: idSchema,
  to: taskStateSchema,
});
export type MoveTaskInput = z.infer<typeof moveTaskInput>;

export const retryTaskInput = z.object({ id: idSchema });
export type RetryTaskInput = z.infer<typeof retryTaskInput>;

/**
 * Delete a Task outright — the board and the Task page both offer it, so a Task no longer has to
 * be deleted by way of the Issue above it.
 *
 * `force` mirrors `deleteIssueInput`'s: without it a Task that other Tasks are blocked on is
 * refused, because deleting it would silently unblock work the Owner deliberately gated. With
 * it, those `blocked_by` edges go too. A *running* Task is never merely refused — the delete
 * stops it first — so no flag covers that.
 */
export const deleteTaskInput = z.object({ id: idSchema, force: z.boolean().default(false) });
export type DeleteTaskInput = z.infer<typeof deleteTaskInput>;

export const taskDeletionImpactInput = z.object({ id: idSchema });
export type TaskDeletionImpactInput = z.infer<typeof taskDeletionImpactInput>;

/**
 * What deleting this Task would destroy, for the confirmation to state. `worktreeCount` counts
 * `worktree` rows still marked active: deleting them drops GateControl's record of those working
 * trees, not the directories, which is why the dialog warns rather than promises.
 */
export const taskDeletionImpactDto = z.object({
  sessionCount: z.number().int().nonnegative(),
  worktreeCount: z.number().int().nonnegative(),
  /** Tasks blocked *by* this one — they are unblocked by the delete. */
  dependentCount: z.number().int().nonnegative(),
  /** Whether an agent has to be stopped before the delete can proceed. */
  running: z.boolean(),
});
export type TaskDeletionImpactDto = z.infer<typeof taskDeletionImpactDto>;

export const listTasksInput = z.object({
  issueId: idSchema.optional(),
  state: taskStateSchema.optional(),
  query: z.string().max(200).optional(),
});
export type ListTasksInput = z.infer<typeof listTasksInput>;

export const getTaskInput = z.object({ id: idSchema });
export type GetTaskInput = z.infer<typeof getTaskInput>;

/**
 * One resolved attachment. `position` travels rather than being implied by array order, because
 * position 0 is what "the primary attachment" means — the worktree the agent is actually started
 * in — and a client that re-sorts the list must not be able to change which one that is.
 *
 * `resultBranch` is separate from `checkoutBranch` even though the two are equal today: the
 * moment the work is pushed to a remote-side branch (#57/#100) they diverge, and giving the row
 * both columns now is what stops that being a second migration.
 */
export const taskRepositoryDto = z.object({
  id: idSchema,
  repositoryId: idSchema,
  baseRef: z.string().nullable(),
  checkoutBranch: z.string(),
  resultBranch: z.string().nullable(),
  position: z.number().int().nonnegative(),
});
export type TaskRepositoryDto = z.infer<typeof taskRepositoryDto>;

export const taskDto = z
  .object({
    id: idSchema,
    issueId: idSchema,
    title: z.string(),
    state: taskStateSchema,
    agentProfileId: idSchema,
    executorProfileId: idSchema,
    /** Every Repository the Task works in, in position order (issue #7). Never empty. */
    repositories: z.array(taskRepositoryDto),
    failureReason: z.string().nullable(),
  })
  .merge(timestampsSchema);
export type TaskDto = z.infer<typeof taskDto>;

export const taskListDto = z.array(taskDto);
export type TaskListDto = z.infer<typeof taskListDto>;

/**
 * Task dependencies — `blocked_by` edges (issue #6).
 *
 * The codes live here rather than in `errors.ts` because `Cycle` is the only error in the
 * product that carries a payload: refusing an edge is useless unless the caller is told *which*
 * path it would have closed, so the error is an object and belongs beside the schemas that
 * describe it.
 */
export const TaskDependencyErrorCode = {
  /** The declared edge would close a cycle; the offending path travels with it (AC-2). */
  Cycle: "TASK_DEPENDENCY_CYCLE",
  /** The Task has at least one predecessor that is not yet `done` (AC-3). */
  Blocked: "TASK_BLOCKED",
} as const;
export type TaskDependencyErrorCode =
  (typeof TaskDependencyErrorCode)[keyof typeof TaskDependencyErrorCode];

export interface TaskDependencyCycleError {
  code: typeof TaskDependencyErrorCode.Cycle;
  /**
   * The cycle the edge would have closed, starting and ending on the Task being blocked:
   * `[A, B, C, A]` reads "A is blocked by B, which is blocked by C, which is blocked by A".
   */
  path: readonly string[];
}

/**
 * `workspaceId` is absent on purpose — it is the tenant key and comes from the session, so an
 * edge can never be aimed at another Workspace by asking for one (Principle V, see `common.ts`).
 */
export const addTaskDependencyInput = z.object({
  taskId: idSchema,
  blockedByTaskId: idSchema,
});
export type AddTaskDependencyInput = z.infer<typeof addTaskDependencyInput>;

export const removeTaskDependencyInput = addTaskDependencyInput;
export type RemoveTaskDependencyInput = z.infer<typeof removeTaskDependencyInput>;

export const listTaskDependenciesInput = z.object({ taskId: idSchema.optional() });
export type ListTaskDependenciesInput = z.infer<typeof listTaskDependenciesInput>;

/**
 * One edge, resolved. The blocker's title and state ride along because the question the board
 * asks is never "which ids block this" but "why is this still blocked" — answering it from the
 * edge alone would cost a second round trip per card.
 */
export const taskDependencyDto = z.object({
  taskId: idSchema,
  blockedByTaskId: idSchema,
  blockedByTitle: z.string(),
  blockedByState: taskStateSchema,
  createdAt: z.string().datetime(),
});
export type TaskDependencyDto = z.infer<typeof taskDependencyDto>;

export const taskDependencyListDto = z.array(taskDependencyDto);
export type TaskDependencyListDto = z.infer<typeof taskDependencyListDto>;
