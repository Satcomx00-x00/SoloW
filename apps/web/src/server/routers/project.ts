import "server-only";
import {
  adoptProjectInput,
  adoptProjectResultDto,
  attachProjectRepositoryInput,
  availableProjectDto,
  createdEpicDto,
  createEpicInput,
  createLocalProjectInput,
  createProjectViewInput,
  detachProjectRepositoryInput,
  externalEpicDto,
  externalGroupDto,
  idSchema,
  listEpicsInput,
  listGroupsInput,
  listProjectItemsInput,
  listProjectViewsInput,
  projectDto,
  projectIdInput,
  projectItemPageDto,
  projectItemsDto,
  projectRefreshDto,
  projectRepositoryDto,
  projectRepositoryListDto,
  projectScanDto,
  projectValueDto,
  projectViewDto,
  projectViewIdInput,
  reorderProjectViewsInput,
  setProjectValueInput,
  updateProjectViewInput,
} from "@solow/contracts";
import { z } from "zod";
import { createEpic, listCreatableGroups, listGroupEpics } from "../dal/issue-create.js";
import {
  deleteProject,
  getProject,
  listAllProjectItems,
  listProjectItems,
  listProjects,
  projectIdForIssue,
} from "../dal/project.js";
import {
  attachProjectRepository,
  createLocalProject,
  detachProjectRepository,
  listProjectRepositories,
} from "../dal/project-local.js";
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

  /**
   * Create a Project SoloW holds outright — no Integration, no provider board (issue #15's
   * reversal, applied to Projects: user request 2026-08-27). The one path to a Project for a
   * Workspace whose providers have nothing to adopt.
   */
  createLocal: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.createLocal",
        tags: ["project"],
        protect: true,
        summary:
          "Create a local Project — a container SoloW owns outright, with no provider board behind it. Its membership is decided by which Repositories are registered under it, not by a sync.",
      },
    })
    .input(createLocalProjectInput)
    .output(projectDto)
    .mutation(async ({ ctx, input }) => unwrap(await createLocalProject(ctx.rctx, input))),

  /**
   * The Repositories registered under a Project — a local Project's membership decision, made
   * visible. Readable on a mirrored Project too, where it is always empty.
   */
  repositories: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.repositories",
        tags: ["project"],
        protect: true,
        summary:
          "The Repositories registered under a Project, and how many Issues each currently contributes. Empty on a mirrored Project — its membership comes from a sync, not this list.",
      },
    })
    .input(projectIdInput)
    .output(projectRepositoryListDto)
    .query(async ({ ctx, input }) => unwrap(await listProjectRepositories(ctx.rctx, input))),

  /**
   * Register a Repository under a local Project, backfilling every Issue it already holds.
   * Refused on a mirrored Project — its membership is the provider's board, not this table's.
   */
  attachRepository: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.attachRepository",
        tags: ["project"],
        protect: true,
        summary:
          "Register a Repository under a local Project. Every Issue it already holds is attached immediately, and every Issue it gets later arrives the same way. Refused on a mirrored Project.",
      },
    })
    .input(attachProjectRepositoryInput)
    .output(projectRepositoryDto)
    .mutation(async ({ ctx, input }) => unwrap(await attachProjectRepository(ctx.rctx, input))),

  /**
   * Drop a Repository from a local Project, and every row it put there — the reverse of
   * `attachRepository`.
   */
  detachRepository: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.detachRepository",
        tags: ["project"],
        protect: true,
        summary:
          "Remove a Repository from a local Project. Every project item and value that Repository's Issues held in this Project is removed with it; the Issues and the Repository itself are untouched.",
      },
    })
    .input(detachProjectRepositoryInput)
    .output(z.object({ projectId: idSchema, repositoryId: idSchema }))
    .mutation(async ({ ctx, input }) => unwrap(await detachProjectRepository(ctx.rctx, input))),

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

  /**
   * Create an Epic on the provider (spec F23a Flow B).
   *
   * On this router rather than `issue` because an epic is a *group* object with no local Issue
   * behind it — nothing is mirrored into the `issue` table, and nothing is written to `project`
   * either: the epic surfaces as a parent row on the next sync, which is the pass that can see
   * which issues the provider now nests under it (F23's "nothing is imported by hand").
   */
  createEpic: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.createEpic",
        tags: ["project"],
        protect: true,
        summary:
          "Create an Epic in a group on the connected provider. Refused with a stated reason on a provider that has no epics; the answer is the epic the provider stored, never what was sent.",
      },
    })
    .input(createEpicInput)
    .output(createdEpicDto)
    .mutation(async ({ ctx, input }) => unwrap(await createEpic(ctx.rctx, input))),

  /** The groups the connection may create an epic in — the "Where" modal's picker. */
  listGroups: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.listGroups",
        tags: ["project"],
        protect: true,
        summary:
          "The groups this connection can create an epic in — a pick rather than a typed guess. Empty on a provider without epics is not the answer; it is refused with the reason.",
      },
    })
    .input(listGroupsInput)
    .output(z.array(externalGroupDto))
    .query(async ({ ctx, input }) => unwrap(await listCreatableGroups(ctx.rctx, input))),

  /** The epics already in a group — the "parent epic" picker on the issue compose form. */
  listEpics: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/project.listEpics",
        tags: ["project"],
        protect: true,
        summary:
          "The epics already in a group, read live from the provider — what an Issue can be created under.",
      },
    })
    .input(listEpicsInput)
    .output(z.array(externalEpicDto))
    .query(async ({ ctx, input }) => unwrap(await listGroupEpics(ctx.rctx, input))),

  delete: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/project.delete",
        tags: ["project"],
        protect: true,
        summary:
          "Delete a Project — local or mirrored — from SoloW's own database: its saved views, fields, values and items. Its Issues are kept and become unassigned; a mirrored Project's provider is never touched.",
      },
    })
    .input(projectIdInput)
    .output(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => unwrap(await deleteProject(ctx.rctx, input.projectId))),
});
