import "server-only";
import {
  adoptProjectInput,
  adoptProjectResultDto,
  availableProjectDto,
  createProjectViewInput,
  idSchema,
  listProjectItemsInput,
  listProjectViewsInput,
  projectDto,
  projectIdInput,
  projectItemPageDto,
  projectItemsDto,
  projectRefreshDto,
  projectScanDto,
  projectValueDto,
  projectViewDto,
  projectViewIdInput,
  reorderProjectViewsInput,
  setProjectValueInput,
  updateProjectViewInput,
} from "@gatecontrol/contracts";
import { z } from "zod";
import {
  getProject,
  listAllProjectItems,
  listProjectItems,
  listProjects,
  projectIdForIssue,
} from "../dal/project.js";
import {
  adoptProject,
  listAvailableProjects,
  refreshProject,
  scanProject,
  setProjectValue,
} from "../dal/project-sync.js";
import {
  createProjectView,
  deleteProjectView,
  listProjectViews,
  reorderProjectViews,
  updateProjectView,
} from "../dal/project-view.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

/**
 * Project planning (spec F23, issues #121–#129).
 *
 * Reads come from the local mirror, never from a provider call per request (F23 NFR-2) — the one
 * exception is `available`, which is a picker asking the provider what exists precisely because
 * there is nothing mirrored yet.
 */
export const projectRouter = router({
  list: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.list",
        tags: ["project"],
        protect: true,
        summary: "Every planning Project mirrored in this Workspace.",
      },
    })
    .input(z.object({}))
    .output(z.array(projectDto))
    .query(async ({ ctx }) => listProjects(ctx.rctx)),

  get: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.get",
        tags: ["project"],
        protect: true,
        summary:
          "One Project with its field set — the columns, their types, and which of them this provider cannot hold.",
      },
    })
    .input(projectIdInput)
    .output(projectDto)
    .query(async ({ ctx, input }) => unwrap(await getProject(ctx.rctx, input.projectId))),

  items: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.items",
        tags: ["project"],
        protect: true,
        summary:
          "One page of a Project's rows, values already read back against their fields' types.",
      },
    })
    .input(listProjectItemsInput)
    .output(projectItemPageDto)
    .query(async ({ ctx, input }) => unwrap(await listProjectItems(ctx.rctx, input))),

  allItems: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.allItems",
        tags: ["project"],
        protect: true,
        summary:
          "Every row of a Project, paged internally up to a ceiling. `truncated` says when the ceiling was reached — a rollup or a filter computed over part of a project must be able to say so.",
      },
    })
    .input(projectIdInput)
    .output(projectItemsDto)
    .query(async ({ ctx, input }) => unwrap(await listAllProjectItems(ctx.rctx, input.projectId))),

  available: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.available",
        tags: ["project"],
        protect: true,
        summary:
          "Projects this Workspace's tokens can see, across every integration that declares the capability. One unreachable host costs its own projects and nothing else.",
      },
    })
    .input(z.object({}))
    .output(z.array(availableProjectDto))
    .query(async ({ ctx }) => listAvailableProjects(ctx.rctx)),

  adopt: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.adopt",
        tags: ["project"],
        protect: true,
        summary:
          "Import a project: create whatever structure the provider needs to hold one (scoped labels on GitLab; nothing on GitHub), pull every issue of its repositories, then scan every page of the project itself. Reports what it created, so a write made without a confirmation step is at least visible afterwards.",
      },
    })
    .input(adoptProjectInput)
    .output(adoptProjectResultDto)
    .mutation(async ({ ctx, input }) => unwrap(await adoptProject(ctx.rctx, input))),

  setValue: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.setValue",
        tags: ["project"],
        protect: true,
        summary:
          "Write one field value to the provider and return what the provider now holds — not what was sent. Refused for a field the provider cannot hold.",
      },
    })
    .input(setProjectValueInput)
    .output(projectValueDto)
    .mutation(async ({ ctx, input }) => unwrap(await setProjectValue(ctx.rctx, input))),

  refresh: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.refresh",
        tags: ["project"],
        protect: true,
        summary:
          "Pull the next page of a Project's mirror. Rows whose Issue has not been ingested yet are skipped and counted, not invented.",
      },
    })
    .input(projectIdInput)
    .output(projectRefreshDto)
    .mutation(async ({ ctx, input }) => unwrap(await refreshProject(ctx.rctx, input.projectId))),

  /**
   * Re-read the whole project, not the next page.
   *
   * `refresh` is the incremental poll; this is the repair. A project adopted before its
   * repositories could be connected holds a completed sync and no rows, and nothing about a
   * one-page refresh would ever fix it — the operator would have to drop the project and adopt it
   * again to get a walk that starts over.
   */
  rescan: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.rescan",
        tags: ["project"],
        protect: true,
        summary:
          "Re-read every page of a Project, connecting the repositories its rows need. The repair path for a mirror that finished a sync holding nothing.",
      },
    })
    .input(projectIdInput)
    .output(projectScanDto)
    .mutation(async ({ ctx, input }) => unwrap(await scanProject(ctx.rctx, input.projectId))),

  /**
   * Which Project holds an Issue — the "back" destination for a flat route.
   *
   * Null is an ordinary answer, not a failure: an Issue in no Project is exactly what the
   * unassigned screen exists for, and a caller renders that link instead.
   */
  forIssue: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.forIssue",
        tags: ["project"],
        protect: true,
        summary:
          "The Project that holds one Issue, or null when no Project does. Lets a Task or Issue page reached by its own flat route link back into the Project it belongs to.",
      },
    })
    .input(z.object({ issueId: idSchema }))
    .output(z.object({ projectId: idSchema.nullable() }))
    .query(async ({ ctx, input }) => ({
      projectId: await projectIdForIssue(ctx.rctx, input.issueId),
    })),

  views: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.views",
        tags: ["project"],
        protect: true,
        summary:
          "The saved views of one Project — the tab strip, in the order the team put it in. A view is a configuration; it carries no items.",
      },
    })
    .input(listProjectViewsInput)
    .output(z.array(projectViewDto))
    .query(async ({ ctx, input }) => listProjectViews(ctx.rctx, input.projectId)),

  createView: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.createView",
        tags: ["project"],
        protect: true,
        summary:
          "Add a tab, at the end of the strip. Its configuration is a filter, a grouping, a sort, a layout and a column set — never a copy of the rows.",
      },
    })
    .input(createProjectViewInput)
    .output(projectViewDto)
    .mutation(async ({ ctx, input }) => unwrap(await createProjectView(ctx.rctx, input))),

  updateView: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.updateView",
        tags: ["project"],
        protect: true,
        summary:
          "Rename a view, reconfigure it, or both. An omitted half is left alone rather than overwritten from a stale copy.",
      },
    })
    .input(updateProjectViewInput)
    .output(projectViewDto)
    .mutation(async ({ ctx, input }) => unwrap(await updateProjectView(ctx.rctx, input))),

  reorderViews: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.reorderViews",
        tags: ["project"],
        protect: true,
        summary:
          "Put the tab strip in the order given. The whole strip at once, so two people dragging tabs cannot interleave into an order neither chose.",
      },
    })
    .input(reorderProjectViewsInput)
    .output(z.array(projectViewDto))
    .mutation(async ({ ctx, input }) => unwrap(await reorderProjectViews(ctx.rctx, input))),

  deleteView: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.deleteView",
        tags: ["project"],
        protect: true,
        summary:
          "Delete a saved view. The rows it selected are the Project's and stay — a tab is a question, not the answer.",
      },
    })
    .input(projectViewIdInput)
    .output(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => unwrap(await deleteProjectView(ctx.rctx, input.viewId))),
});
