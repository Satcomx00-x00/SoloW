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
    .meta({ openapi: { method: "POST", path: "/task.create", tags: ["task"], protect: true } })
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
    .meta({ openapi: { method: "GET", path: "/task.list", tags: ["task"], protect: true } })
    .input(listTasksInput)
    .output(taskListDto)
    .query(async ({ ctx, input }) => unwrap(await listTasks(ctx.rctx, input))),

  get: ownerProcedure
    .meta({ openapi: { method: "GET", path: "/task.get", tags: ["task"], protect: true } })
    .input(getTaskInput)
    .output(taskDto)
    .query(async ({ ctx, input }) => unwrap(await getTaskById(ctx.rctx, input.id))),

  launch: ownerProcedure
    .meta({ openapi: { method: "POST", path: "/task.launch", tags: ["task"], protect: true } })
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
    .meta({ openapi: { method: "POST", path: "/task.move", tags: ["task"], protect: true } })
    .input(moveTaskInput)
    .output(taskDto)
    .mutation(async ({ ctx, input }) => {
      const task = unwrap(await getTaskById(ctx.rctx, input.id));
      unwrap(canTransitionTask(task.state, input.to));
      return unwrap(await updateTaskState(ctx.rctx, task.id, input.to));
    }),

  retry: ownerProcedure
    .meta({ openapi: { method: "POST", path: "/task.retry", tags: ["task"], protect: true } })
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
