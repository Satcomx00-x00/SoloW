import "server-only";
import {
  addTaskDependencyInput,
  createTaskInput,
  deleteTaskInput,
  getTaskInput,
  launchTaskInput,
  listTaskDependenciesInput,
  listTasksInput,
  moveTaskInput,
  removeTaskDependencyInput,
  retryTaskInput,
  setTaskRepositoriesInput,
  submitTaskForReviewInput,
  TaskDependencyErrorCode,
  type TaskDto,
  TaskErrorCode,
  taskDeletionImpactDto,
  taskDeletionImpactInput,
  taskDependencyListDto,
  taskDto,
  taskListDto,
} from "@gatecontrol/contracts";
import {
  buildCreateTaskPayload,
  canTransitionTask,
  formatDependencyCycle,
  isLaunchable,
  unsatisfiedDependencies,
  withinConcurrencyCap,
} from "@gatecontrol/core";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { RequestContext } from "../dal/context.js";
import { getIssueById } from "../dal/issue.js";
import { getAgentProfile, getExecutorProfile } from "../dal/profile.js";
import { getRepository } from "../dal/repository.js";
import { createSession } from "../dal/session.js";
import {
  activeSessionForTask,
  addTaskDependencyEdge,
  countRunningForAgentProfile,
  createTaskRecord,
  deleteTask,
  getTaskById,
  listTaskDependencies,
  listTasks,
  removeTaskDependencyEdge,
  setTaskRepositories,
  taskDeletionImpact,
  updateTaskState,
} from "../dal/task.js";
import { orchestrator } from "../orchestrator-client.js";
import { ownerProcedure, rateLimit, router, unwrap } from "../trpc.js";

/**
 * The start gate (issue #6 AC-3, rule 2): a Task with a predecessor that is not yet `done` is
 * not started by anything.
 *
 * Deliberately one function called by every start path rather than a check repeated in each.
 * The invariant the issue states is "never auto-started by *any* path", and the way that
 * invariant dies is the next start path added — workflow advance, a coordinator — being written
 * by someone who did not know a check existed to repeat. There is nothing to remember here: a
 * new start path either calls this or it does not start Tasks. Exported for the same reason:
 * `review.decide` resumes an agent, so it is a start path and calls this one, rather than
 * growing a second opinion about what "blocked" means.
 *
 * The MCP surface needs no gate of its own; `mcp/tools.ts` derives every tool from these same
 * procedures and dispatches back through them, so `task_launch` over MCP arrives here too.
 */
export async function requireUnblocked(rctx: RequestContext, taskId: string): Promise<void> {
  const deps = unwrap(await listTaskDependencies(rctx, { taskId }));
  if (unsatisfiedDependencies(deps).length > 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: TaskDependencyErrorCode.Blocked });
  }
}

/**
 * Re-run one Task in a fresh Session — the shared body of `task.retry` and the automatic
 * resumption an Owner triggers by replacing an expired credential (issue #63, spec AC-013).
 *
 * A start refused here (an unmet dependency, an illegal transition) is the caller's problem to
 * handle: `task.retry` lets it surface as the request's own error, while the credential-renewal
 * path calls this once per blocked Task and catches the refusal there — one Task that still
 * cannot start (its dependency graph changed since it failed) must not stop the rest of the
 * batch from resuming.
 */
/**
 * Start an agent on a Task. The one path into `running`, whoever asked.
 *
 * There used to be two: `launch`/`retry` created a Session and published to the durable engine,
 * while `move` into `running` wrote the column and stopped — no Session, no agent, and a card
 * sitting in Running with nothing behind it. The board offered both gestures and only one of them
 * worked, which is a trap rather than a choice, and it stranded a real Task for hours.
 *
 * Unifying them also puts the concurrency cap on every entry. `resumeTask` skipped it, so a
 * Workspace at its limit could be pushed past it by retrying rather than launching — the cap held
 * on the path people used least.
 */
export async function startTaskRun(rctx: RequestContext, taskId: string): Promise<TaskDto> {
  const existing = unwrap(await getTaskById(rctx, taskId));
  unwrap(canTransitionTask(existing.state, "running"));
  await requireUnblocked(rctx, existing.id);

  // The Agent Profile concurrency cap (spec FR-017), on every path into `running`.
  const profile = unwrap(await getAgentProfile(rctx, existing.agentProfileId));
  const running = await countRunningForAgentProfile(rctx, existing.agentProfileId);
  if (!withinConcurrencyCap(profile.concurrencyCap, running)) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: TaskErrorCode.ConcurrencyCapReached,
    });
  }

  const session = unwrap(await createSession(rctx, existing.id));
  // `failureReason: null` explicitly, though `updateTaskState` now clears it on any exit from
  // `failed` — a new run's Task must not carry the last one's reason whichever way it started.
  const updated = unwrap(
    await updateTaskState(rctx, existing.id, "running", { failureReason: null }),
  );
  await orchestrator.enqueueTaskRun({
    workspaceId: rctx.workspaceId,
    taskId: existing.id,
    sessionId: session.id,
  });
  await orchestrator.announceTask({
    workspaceId: rctx.workspaceId,
    taskId: existing.id,
    state: updated.state,
  });
  return updated;
}

/** Retry a failed or parked Task. Kept as its own name because that is what callers mean. */
export async function resumeTask(rctx: RequestContext, taskId: string): Promise<TaskDto> {
  return startTaskRun(rctx, taskId);
}

export const taskRouter = router({
  create: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.create",
        tags: ["task"],
        protect: true,
        summary:
          "Create a Task under an Issue, binding an Agent Profile, an Executor Profile, and one or more Repositories — each with its own base ref and checkout branch. Creates it in the backlog; it does not start an agent — use task.launch for that.",
      },
    })
    .input(createTaskInput)
    .output(taskDto)
    .mutation(async ({ ctx, input }) => {
      // Ownership: every referenced entity must belong to this Workspace, or the create is
      // a cross-tenant reference and must fail (Principle V). Each lookup is workspace-scoped.
      unwrap(await getIssueById(ctx.rctx, input.issueId));
      unwrap(await getAgentProfile(ctx.rctx, input.agentProfileId));
      unwrap(await getExecutorProfile(ctx.rctx, input.executorProfileId));
      // Every attached Repository, resolved before anything is written: one id from another
      // Workspace has to fail the whole create, not attach the rest and leave a Task half
      // pointed at a tenant it cannot see (issue #7 AC-1).
      for (const attachment of input.repositories) {
        unwrap(await getRepository(ctx.rctx, attachment.repositoryId));
      }

      const payload = unwrap(buildCreateTaskPayload(input, { workspaceId: ctx.rctx.workspaceId }));
      return unwrap(await createTaskRecord(ctx.rctx, payload));
    }),

  setRepositories: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.setRepositories",
        tags: ["task"],
        protect: true,
        summary:
          "Replace the whole set of Repositories a Task works in, each with its own base ref and checkout branch. Refused once the Task has left the backlog or ready states, because its worktrees are already live.",
      },
    })
    .input(setTaskRepositoriesInput)
    .output(taskDto)
    .mutation(async ({ ctx, input }) => {
      unwrap(await getTaskById(ctx.rctx, input.taskId));
      for (const attachment of input.repositories) {
        unwrap(await getRepository(ctx.rctx, attachment.repositoryId));
      }
      return unwrap(await setTaskRepositories(ctx.rctx, input));
    }),

  list: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/task.list",
        tags: ["task"],
        protect: true,
        summary: "List Tasks on the board, optionally filtered by Issue or lifecycle state.",
      },
    })
    .input(listTasksInput)
    .output(taskListDto)
    .query(async ({ ctx, input }) => unwrap(await listTasks(ctx.rctx, input))),

  get: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/task.get",
        tags: ["task"],
        protect: true,
        summary: "Fetch one Task by id, including its current state and result branch.",
      },
    })
    .input(getTaskInput)
    .output(taskDto)
    .query(async ({ ctx, input }) => unwrap(await getTaskById(ctx.rctx, input.id))),

  launch: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.launch",
        tags: ["task"],
        protect: true,
        summary:
          "Start an agent on a ready Task in its own isolated worktree. Rate limited, and refused if the Agent Profile is already at its concurrency cap. The run ends at a human review gate — it never merges on its own.",
      },
    })
    .use(rateLimit("task.launch"))
    .input(launchTaskInput)
    .output(taskDto)
    .mutation(async ({ ctx, input }) => {
      const task = unwrap(await getTaskById(ctx.rctx, input.id));
      if (!isLaunchable(task.state)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: TaskErrorCode.NotReady });
      }
      await requireUnblocked(ctx.rctx, task.id);
      // Enforce the Agent Profile concurrency cap (spec FR-017).
      const profile = unwrap(await getAgentProfile(ctx.rctx, task.agentProfileId));
      const running = await countRunningForAgentProfile(ctx.rctx, task.agentProfileId);
      if (!withinConcurrencyCap(profile.concurrencyCap, running)) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: TaskErrorCode.ConcurrencyCapReached,
        });
      }
      return startTaskRun(ctx.rctx, task.id);
    }),

  move: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.move",
        tags: ["task"],
        protect: true,
        summary:
          "Move a Task to another lifecycle state. Illegal transitions are refused by the state machine rather than applied.",
      },
    })
    .input(moveTaskInput)
    .output(taskDto)
    .mutation(async ({ ctx, input }) => {
      const task = unwrap(await getTaskById(ctx.rctx, input.id));
      unwrap(canTransitionTask(task.state, input.to));
      // Moving into `running` *is* starting, and now does it: same Session, same concurrency cap,
      // same publish to the durable engine as Launch and Retry. It used to write the column and
      // nothing else, which left a card in Running with no agent behind it and no way to tell.
      if (input.to === "running") return startTaskRun(ctx.rctx, task.id);
      const moved = unwrap(await updateTaskState(ctx.rctx, task.id, input.to));
      // Every client watching, not just the one that dragged the card.
      await orchestrator.announceTask({
        workspaceId: ctx.rctx.workspaceId,
        taskId: moved.id,
        state: moved.state,
      });
      return moved;
    }),

  submitForReview: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.submitForReview",
        tags: ["task"],
        protect: true,
        summary:
          "Open the review gate on a Task whose agent has declared it finished. Refused when no declaration has been made — the gate is for judging finished work, not work still in progress.",
      },
    })
    .input(submitTaskForReviewInput)
    .output(taskDto)
    .mutation(async ({ ctx, input }) => {
      const task = unwrap(await getTaskById(ctx.rctx, input.id));
      // The agent's own word, and only `changes_ready` counts: a run that finished having changed
      // nothing (`nothing_to_do`) has nothing to approve, and one that gave up (`blocked`) has not
      // finished at all. Checked here rather than only in the UI, because the button is not the
      // only caller — MCP and the OpenAPI surface reach this too.
      if (task.completedAt === null || task.completedOutcome !== "changes_ready") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: TaskErrorCode.NotComplete,
        });
      }
      unwrap(canTransitionTask(task.state, "review"));
      const opened = unwrap(await updateTaskState(ctx.rctx, task.id, "review"));
      await orchestrator.announceTask({
        workspaceId: ctx.rctx.workspaceId,
        taskId: opened.id,
        state: opened.state,
      });
      return opened;
    }),

  retry: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.retry",
        tags: ["task"],
        protect: true,
        summary:
          "Re-run a failed or parked Task in a fresh Session, clearing the previous failure reason.",
      },
    })
    .input(retryTaskInput)
    .output(taskDto)
    .mutation(async ({ ctx, input }) => resumeTask(ctx.rctx, input.id)),

  dependencies: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/task.dependencies",
        tags: ["task"],
        protect: true,
        summary:
          "List blocked_by dependencies — for one Task, or for every Task in the Workspace when no id is given. Each edge carries the blocking Task's title and current state, so a caller can see what is still outstanding.",
      },
    })
    .input(listTaskDependenciesInput)
    .output(taskDependencyListDto)
    .query(async ({ ctx, input }) => unwrap(await listTaskDependencies(ctx.rctx, input))),

  addDependency: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.addDependency",
        tags: ["task"],
        protect: true,
        summary:
          "Declare that a Task is blocked by another Task in the same Workspace. Refused if the edge would create a cycle, naming the offending path. Re-declaring an existing dependency is a no-op.",
      },
    })
    .input(addTaskDependencyInput)
    .output(taskDependencyListDto)
    .mutation(async ({ ctx, input }) => {
      // Both ends resolved through the workspace-scoped lookup before anything is written, so an
      // edge aimed at another Workspace's Task is a NOT_FOUND and never becomes a row (AC-5).
      const task = unwrap(await getTaskById(ctx.rctx, input.taskId));
      unwrap(await getTaskById(ctx.rctx, input.blockedByTaskId));

      // The cycle check and the insert are one transaction inside the DAL, not two statements
      // here: two concurrent adds asking for the two halves of a cycle would otherwise both read
      // the pre-insert graph and both be allowed through.
      const written = await addTaskDependencyEdge(ctx.rctx, {
        taskId: task.id,
        blockedByTaskId: input.blockedByTaskId,
      });
      if (!written.ok) {
        // Ids, not titles, in the message: the path travels as text through `TRPCError.message`
        // (there is no error formatter carrying structure yet), and a Task title containing the
        // separator would otherwise break the path the dialog reads back.
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `${written.error.code}: ${formatDependencyCycle(written.error.path)}`,
        });
      }

      return unwrap(await listTaskDependencies(ctx.rctx, { taskId: task.id }));
    }),

  removeDependency: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.removeDependency",
        tags: ["task"],
        protect: true,
        summary:
          "Withdraw a blocked_by dependency between two Tasks, returning the Task's remaining dependencies.",
      },
    })
    .input(removeTaskDependencyInput)
    .output(taskDependencyListDto)
    .mutation(async ({ ctx, input }) => {
      const task = unwrap(await getTaskById(ctx.rctx, input.taskId));
      unwrap(await removeTaskDependencyEdge(ctx.rctx, input));
      return unwrap(await listTaskDependencies(ctx.rctx, { taskId: task.id }));
    }),
  deletionImpact: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/task.deletionImpact",
        tags: ["task"],
        protect: true,
        summary:
          "Count what deleting this Task would destroy — sessions, active worktrees, and the Tasks currently blocked by it.",
      },
    })
    .input(taskDeletionImpactInput)
    .output(taskDeletionImpactDto)
    .query(async ({ ctx, input }) => unwrap(await taskDeletionImpact(ctx.rctx, input.id))),

  delete: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.delete",
        tags: ["task"],
        protect: true,
        summary:
          "Delete a Task with its sessions, reviews and worktree records. A running Task is stopped first. Refused while other Tasks are blocked by it unless `force` is set, which drops those edges too.",
      },
    })
    .input(deleteTaskInput)
    .output(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Stopping lives here, not in the DAL: reaching a running agent is an orchestrator
      // hand-off, and the DAL stays pure database. It re-checks the same condition inside its
      // transaction, which is what makes this safe rather than merely polite.
      const sessionId = await activeSessionForTask(ctx.rctx, input.id);
      let stopIssued = false;
      if (sessionId) {
        try {
          await orchestrator.stopTaskRun({
            workspaceId: ctx.rctx.workspaceId,
            taskId: input.id,
            sessionId,
          });
          // The orchestrator accepted the cancellation. It unwinds between steps, so the Task
          // row will still read `running` for a moment — `stopIssued` is what tells the DAL that
          // the stale flag is expected rather than a live agent it must protect.
          stopIssued = true;
        } catch (cause) {
          // Nothing has been deleted yet, so refusing leaves the Task exactly as it was — the
          // one outcome that cannot orphan a running agent.
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: TaskErrorCode.StopFailed,
            cause,
          });
        }
      }
      return unwrap(await deleteTask(ctx.rctx, input, { stopIssued }));
    }),
});
