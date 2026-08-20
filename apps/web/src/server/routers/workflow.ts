import "server-only";
import {
  acknowledgeTaskWorkflowDriftInput,
  addWorkflowStepInput,
  advanceTaskWorkflowInput,
  attachTaskWorkflowInput,
  createWorkflowInput,
  deleteWorkflowInput,
  deleteWorkflowStepInput,
  detachTaskWorkflowInput,
  getTaskWorkflowInput,
  getWorkflowInput,
  listWorkflowsInput,
  renameWorkflowInput,
  reorderWorkflowStepInput,
  taskWorkflowBindingDto,
  updateWorkflowStepInput,
  workflowAdvanceDto,
  workflowDetachDto,
  workflowDto,
  workflowListDto,
  workflowWithStepsDto,
} from "@gatecontrol/contracts";
import {
  acknowledgeTaskWorkflowDrift,
  addWorkflowStep,
  advanceTaskWorkflow,
  attachTaskWorkflow,
  createWorkflow,
  deleteWorkflow,
  deleteWorkflowStep,
  detachTaskWorkflow,
  getTaskWorkflowBinding,
  getWorkflowWithSteps,
  listWorkflows,
  renameWorkflow,
  reorderWorkflowStep,
  updateWorkflowStep,
} from "../dal/workflow.js";
import { router, unwrap, workflowProcedure } from "../trpc.js";

/**
 * The Workflow API (issue #5, spec F03).
 *
 * Every procedure is on `workflowProcedure`, which is `ff-core-program` *and* `ff-workflows`:
 * a Workflow mutates Tasks, so it must not stay reachable when the core kill switch is off.
 *
 * Nothing here re-implements a rule. Ownership, ordering and the advance decision all live in
 * the DAL and `@gatecontrol/core`; this file is the shape of the surface and the mapping from a
 * `Result` error to an HTTP status, which is what `unwrap` does.
 */
export const workflowRouter = router({
  list: workflowProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workflow.list",
        tags: ["workflow"],
        protect: true,
        summary:
          "List this Workspace's Workflows — repeatable pipelines of Steps, each Step run by its own Agent Profile. Returns the definition version and how many Steps each has, not the Steps themselves.",
      },
    })
    .input(listWorkflowsInput)
    .output(workflowListDto)
    .query(async ({ ctx }) => unwrap(await listWorkflows(ctx.rctx))),

  get: workflowProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workflow.get",
        tags: ["workflow"],
        protect: true,
        summary: "Read one Workflow with its Steps, in pipeline order.",
      },
    })
    .input(getWorkflowInput)
    .output(workflowWithStepsDto)
    .query(async ({ ctx, input }) => unwrap(await getWorkflowWithSteps(ctx.rctx, input.id))),

  create: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.create",
        tags: ["workflow"],
        protect: true,
        summary:
          "Create an empty Workflow. Steps are added afterwards with workflow.addStep; a Workflow with no Steps cannot be attached to a Task.",
      },
    })
    .input(createWorkflowInput)
    .output(workflowDto)
    .mutation(async ({ ctx, input }) => unwrap(await createWorkflow(ctx.rctx, input))),

  rename: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.rename",
        tags: ["workflow"],
        protect: true,
        summary: "Rename a Workflow, and optionally replace its description.",
      },
    })
    .input(renameWorkflowInput)
    .output(workflowDto)
    .mutation(async ({ ctx, input }) => unwrap(await renameWorkflow(ctx.rctx, input))),

  delete: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.delete",
        tags: ["workflow"],
        protect: true,
        summary:
          "Delete a Workflow and its Steps. Refused while any Task still follows it, so no Task is left with a cursor pointing at nothing.",
      },
    })
    .input(deleteWorkflowInput)
    .output(workflowListDto)
    .mutation(async ({ ctx, input }) => {
      unwrap(await deleteWorkflow(ctx.rctx, input.id));
      return unwrap(await listWorkflows(ctx.rctx));
    }),

  addStep: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.addStep",
        tags: ["workflow"],
        protect: true,
        summary:
          "Add a Step to a Workflow, bound to an Agent Profile with its own prompt template and gate rule. Appends unless afterStepId names the Step it should follow; inserting in the middle writes one row and reorders nothing.",
      },
    })
    .input(addWorkflowStepInput)
    .output(workflowWithStepsDto)
    .mutation(async ({ ctx, input }) => unwrap(await addWorkflowStep(ctx.rctx, input))),

  updateStep: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.updateStep",
        tags: ["workflow"],
        protect: true,
        summary:
          "Change a Step's name, Agent Profile, prompt template, gate or advance rule. Bumps the Workflow's definition version, so an attached Task reports the drift.",
      },
    })
    .input(updateWorkflowStepInput)
    .output(workflowWithStepsDto)
    .mutation(async ({ ctx, input }) => unwrap(await updateWorkflowStep(ctx.rctx, input))),

  reorderStep: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.reorderStep",
        tags: ["workflow"],
        protect: true,
        summary:
          "Move a Step between the two Steps it should sit between; either may be null for the ends of the list. Refused if those two are not adjacent any more, which means the caller was looking at a stale order.",
      },
    })
    .input(reorderWorkflowStepInput)
    .output(workflowWithStepsDto)
    .mutation(async ({ ctx, input }) => unwrap(await reorderWorkflowStep(ctx.rctx, input))),

  deleteStep: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.deleteStep",
        tags: ["workflow"],
        protect: true,
        summary:
          "Remove a Step from a Workflow. Refused while a Task's cursor sits on it, because that Task would then be unable to resume.",
      },
    })
    .input(deleteWorkflowStepInput)
    .output(workflowWithStepsDto)
    .mutation(async ({ ctx, input }) => unwrap(await deleteWorkflowStep(ctx.rctx, input))),

  attachTask: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.attachTask",
        tags: ["workflow"],
        protect: true,
        summary:
          "Put a Task on a Workflow, at its first Step, recording the definition version in force. Refused once the Task has left backlog or ready, and refused once it has begun a pipeline — a cursor that has moved, a handoff, or a spent approval — so re-attaching cannot silently discard work already done.",
      },
    })
    .input(attachTaskWorkflowInput)
    .output(taskWorkflowBindingDto)
    .mutation(async ({ ctx, input }) => unwrap(await attachTaskWorkflow(ctx.rctx, input))),

  detachTask: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.detachTask",
        tags: ["workflow"],
        protect: true,
        summary:
          "Take a Task off its Workflow, clearing its step cursor and carried handoff. Refused for a Task that follows no Workflow, and for one that has left backlog or ready — detaching mid-run would throw away the durable cursor and defeat the guards that refuse to delete a Step a run is on.",
      },
    })
    .input(detachTaskWorkflowInput)
    .output(workflowDetachDto)
    .mutation(async ({ ctx, input }) => {
      unwrap(await detachTaskWorkflow(ctx.rctx, input.taskId));
      return { taskId: input.taskId };
    }),

  taskBinding: workflowProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/workflow.taskBinding",
        tags: ["workflow"],
        protect: true,
        summary:
          "Where a Task is in its Workflow: the current Step with its Agent Profile, the whole Step list, the carried handoff, and the brief the current Step's agent should be given.",
      },
    })
    .input(getTaskWorkflowInput)
    .output(taskWorkflowBindingDto)
    .query(async ({ ctx, input }) => unwrap(await getTaskWorkflowBinding(ctx.rctx, input.taskId))),

  acknowledgeDrift: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.acknowledgeDrift",
        tags: ["workflow"],
        protect: true,
        summary:
          "Accept the Workflow definition as it now stands for one Task, clearing its drift warning. The step cursor is untouched — this records that a person read what changed underneath the run and chose to carry on.",
      },
    })
    .input(acknowledgeTaskWorkflowDriftInput)
    .output(taskWorkflowBindingDto)
    .mutation(async ({ ctx, input }) =>
      unwrap(await acknowledgeTaskWorkflowDrift(ctx.rctx, input)),
    ),

  advanceTask: workflowProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/workflow.advanceTask",
        tags: ["workflow"],
        protect: true,
        summary:
          "Report that a Task's current Step finished, moving it to the next Step and carrying the handoff. fromStepId names the Step the caller believes it is finishing, so a redelivered call is refused rather than skipping a Step. The same Task is moved; no new Task is created. The last Step reports completed only once a human approval has been recorded that no earlier gate already spent, whatever the Step's gate says.",
      },
    })
    .input(advanceTaskWorkflowInput)
    .output(workflowAdvanceDto)
    .mutation(async ({ ctx, input }) => unwrap(await advanceTaskWorkflow(ctx.rctx, input))),
});
