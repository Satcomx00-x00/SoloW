import "server-only";
import { TRPCError } from "@trpc/server";
import {
  TaskErrorCode,
  createTaskInput,
  getTaskInput,
  launchTaskInput,
  listTasksInput,
  moveTaskInput,
  retryTaskInput,
} from "@gatecontrol/contracts";
import { ownerProcedure, router, unwrap } from "../trpc.js";
import {
  countRunningForAgentProfile,
  createTaskRecord,
  getTaskById,
  listTasks,
  updateTaskState,
} from "../dal/task.js";
import { getAgentProfile } from "../dal/profile.js";
import { createSession } from "../dal/session.js";
import {
  buildCreateTaskPayload,
  canTransitionTask,
  isLaunchable,
  withinConcurrencyCap,
} from "@gatecontrol/core";
import { orchestrator } from "../orchestrator-client.js";

export const taskRouter = router({
  create: ownerProcedure.input(createTaskInput).mutation(async ({ ctx, input }) => {
    const payload = unwrap(buildCreateTaskPayload(input, { workspaceId: ctx.rctx.workspaceId }));
    return unwrap(await createTaskRecord(ctx.rctx, payload));
  }),

  list: ownerProcedure
    .input(listTasksInput)
    .query(async ({ ctx, input }) => unwrap(await listTasks(ctx.rctx, input))),

  get: ownerProcedure
    .input(getTaskInput)
    .query(async ({ ctx, input }) => unwrap(await getTaskById(ctx.rctx, input.id))),

  launch: ownerProcedure.input(launchTaskInput).mutation(async ({ ctx, input }) => {
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

  move: ownerProcedure.input(moveTaskInput).mutation(async ({ ctx, input }) => {
    const task = unwrap(await getTaskById(ctx.rctx, input.id));
    unwrap(canTransitionTask(task.state, input.to));
    return unwrap(await updateTaskState(ctx.rctx, task.id, input.to));
  }),

  retry: ownerProcedure.input(retryTaskInput).mutation(async ({ ctx, input }) => {
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
