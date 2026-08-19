import "server-only";
import {
  createTaskInput,
  getTaskInput,
  launchTaskInput,
  listTasksInput,
  moveTaskInput,
  retryTaskInput,
  TaskErrorCode,
  taskDto,
  taskListDto,
} from "@gatecontrol/contracts";
import {
  buildCreateTaskPayload,
  canTransitionTask,
  isLaunchable,
  withinConcurrencyCap,
} from "@gatecontrol/core";
import { TRPCError } from "@trpc/server";
import { getIssueById } from "../dal/issue.js";
import { getAgentProfile, getExecutorProfile } from "../dal/profile.js";
import { getRepository } from "../dal/repository.js";
import { createSession } from "../dal/session.js";
import {
  countRunningForAgentProfile,
  createTaskRecord,
  getTaskById,
  listTasks,
  updateTaskState,
} from "../dal/task.js";
import { orchestrator } from "../orchestrator-client.js";
import { ownerProcedure, rateLimit, router, unwrap } from "../trpc.js";

export const taskRouter = router({
  create: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/task.create",
        tags: ["task"],
        protect: true,
        summary:
          "Create a Task under an Issue, binding an Agent Profile, an Executor Profile, and a Repository. Creates it in the backlog; it does not start an agent — use task.launch for that.",
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
      unwrap(await getRepository(ctx.rctx, input.repositoryId));

      const payload = unwrap(buildCreateTaskPayload(input, { workspaceId: ctx.rctx.workspaceId }));
      return unwrap(await createTaskRecord(ctx.rctx, payload));
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
      // Enforce the Agent Profile concurrency cap (spec FR-017).
      const profile = unwrap(await getAgentProfile(ctx.rctx, task.agentProfileId));
      const running = await countRunningForAgentProfile(ctx.rctx, task.agentProfileId);
      if (!withinConcurrencyCap(profile.concurrencyCap, running)) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: TaskErrorCode.ConcurrencyCapReached,
        });
      }
      unwrap(canTransitionTask(task.state, "running"));
      const session = unwrap(await createSession(ctx.rctx, task.id));
      const updated = unwrap(await updateTaskState(ctx.rctx, task.id, "running"));
      await orchestrator.enqueueTaskRun({
        workspaceId: ctx.rctx.workspaceId,
        taskId: task.id,
        sessionId: session.id,
      });
      return updated;
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
      return unwrap(await updateTaskState(ctx.rctx, task.id, input.to));
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
    .mutation(async ({ ctx, input }) => {
      const task = unwrap(await getTaskById(ctx.rctx, input.id));
      unwrap(canTransitionTask(task.state, "running"));
      const session = unwrap(await createSession(ctx.rctx, task.id));
      const updated = unwrap(
        await updateTaskState(ctx.rctx, task.id, "running", { failureReason: null }),
      );
      await orchestrator.enqueueTaskRun({
        workspaceId: ctx.rctx.workspaceId,
        taskId: task.id,
        sessionId: session.id,
      });
      return updated;
    }),
});
