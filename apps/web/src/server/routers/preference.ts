import "server-only";
import {
  appearanceDto,
  clearReviewDraftInput,
  getReviewDraftInput,
  getSurfaceLayoutInput,
  recentTasksDto,
  recordRecentTaskInput,
  reviewDraftDto,
  setAppearanceInput,
  setReviewDraftInput,
  setSurfaceLayoutInput,
  setTaskDefaultsInput,
  setTaskPaneLayoutInput,
  surfaceLayoutDto,
  taskDefaultsDto,
  taskPaneLayoutDto,
} from "@solow/contracts";
import { z } from "zod";
import {
  clearReviewDraft,
  getAppearance,
  getRecentTasks,
  getReviewDraft,
  getSurfaceLayout,
  getTaskDefaults,
  getTaskPaneLayout,
  recordRecentTask,
  setAppearance,
  setReviewDraft,
  setSurfaceLayout,
  setTaskDefaults,
  setTaskPaneLayout,
} from "../dal/preference.js";
import { ownerProcedure, router, unwrap, workspaceControlsProcedure } from "../trpc.js";

/**
 * Interface preferences that belong to a user rather than to a browser (issue #3, AC-3).
 *
 * Neither procedure takes a Workspace or a user id. Both are read from the session inside the
 * DAL (Principle V), which is what makes "restore my arrangement on another device" mean the
 * same thing as "restore it for me": the only device-specific part of the request is which
 * session it authenticated with.
 */
export const preferenceRouter = router({
  getSurfaceLayout: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/preference.getSurfaceLayout",
        tags: ["preference"],
        protect: true,
        summary:
          "Read the signed-in user's arrangement of a contributed surface. Returns the default arrangement when nothing is saved.",
      },
    })
    .input(getSurfaceLayoutInput)
    .output(surfaceLayoutDto)
    .query(async ({ ctx, input }) => unwrap(await getSurfaceLayout(ctx.rctx, input.surface))),

  setSurfaceLayout: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/preference.setSurfaceLayout",
        tags: ["preference"],
        protect: true,
        summary:
          "Save the signed-in user's arrangement of a contributed surface — the complete order and hidden list, not a delta.",
      },
    })
    .input(setSurfaceLayoutInput)
    .output(surfaceLayoutDto)
    .mutation(async ({ ctx, input }) => unwrap(await setSurfaceLayout(ctx.rctx, input))),

  getTaskPaneLayout: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/preference.getTaskPaneLayout",
        tags: ["preference"],
        protect: true,
        summary:
          "Read the signed-in user's Task page split — the width of the changes column and whether it is folded. Returns the default when nothing is saved.",
      },
    })
    .input(z.object({}))
    .output(taskPaneLayoutDto)
    .query(async ({ ctx }) => unwrap(await getTaskPaneLayout(ctx.rctx))),

  setTaskPaneLayout: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/preference.setTaskPaneLayout",
        tags: ["preference"],
        protect: true,
        summary: "Save the signed-in user's Task page split.",
      },
    })
    .input(setTaskPaneLayoutInput)
    .output(taskPaneLayoutDto)
    .mutation(async ({ ctx, input }) => unwrap(await setTaskPaneLayout(ctx.rctx, input))),

  getRecentTasks: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/preference.getRecentTasks",
        tags: ["preference"],
        protect: true,
        summary:
          "The signed-in user's recently visited Tasks, most recent first. Empty when nothing is saved.",
      },
    })
    .input(z.object({}))
    .output(recentTasksDto)
    .query(async ({ ctx }) => unwrap(await getRecentTasks(ctx.rctx))),

  recordRecentTask: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/preference.recordRecentTask",
        tags: ["preference"],
        protect: true,
        summary: "Move a Task to the front of the signed-in user's recent list.",
      },
    })
    .input(recordRecentTaskInput)
    .output(recentTasksDto)
    .mutation(async ({ ctx, input }) => unwrap(await recordRecentTask(ctx.rctx, input.taskId))),

  getReviewDraft: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/preference.getReviewDraft",
        tags: ["preference"],
        protect: true,
        summary:
          "The signed-in user's review draft on a Task — files ticked as viewed and notes not yet sent — or null when there is none.",
      },
    })
    .input(getReviewDraftInput)
    .output(reviewDraftDto)
    .query(async ({ ctx, input }) => unwrap(await getReviewDraft(ctx.rctx, input.taskId))),

  setReviewDraft: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/preference.setReviewDraft",
        tags: ["preference"],
        protect: true,
        summary: "Save the signed-in user's review draft on a Task, replacing what was there.",
      },
    })
    .input(setReviewDraftInput)
    .output(reviewDraftDto)
    .mutation(async ({ ctx, input }) =>
      unwrap(await setReviewDraft(ctx.rctx, input.taskId, input.draft)),
    ),

  clearReviewDraft: ownerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/preference.clearReviewDraft",
        tags: ["preference"],
        protect: true,
        summary: "Forget the signed-in user's review draft on a Task.",
      },
    })
    .input(clearReviewDraftInput)
    .output(reviewDraftDto)
    .mutation(async ({ ctx, input }) => unwrap(await clearReviewDraft(ctx.rctx, input.taskId))),

  /*
   * The last two sit on `workspaceControlsProcedure`, not `ownerProcedure`, and the difference
   * is deliberate. Everything above is state *about the core loop* — a review draft means
   * nothing with the loop off. A theme is not: the app still has to render when
   * `ff-core-program` is off, and a theme query that failed in that state would leave the shell
   * unable to find out how it is meant to look. The new-Task defaults keep it company because
   * they are written on the same Settings page and share its switch (spec F16).
   */
  getAppearance: workspaceControlsProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/preference.getAppearance",
        tags: ["preference"],
        protect: true,
        summary:
          "The signed-in user's theme: `system`, `light` or `dark`. Answers the default (`dark`) when nothing is saved.",
      },
    })
    .input(z.object({}))
    .output(appearanceDto)
    .query(async ({ ctx }) => unwrap(await getAppearance(ctx.rctx))),

  setAppearance: workspaceControlsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/preference.setAppearance",
        tags: ["preference"],
        protect: true,
        summary: "Set the signed-in user's theme.",
      },
    })
    .input(setAppearanceInput)
    .output(appearanceDto)
    .mutation(async ({ ctx, input }) => unwrap(await setAppearance(ctx.rctx, input))),

  getTaskDefaults: workspaceControlsProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/preference.getTaskDefaults",
        tags: ["preference"],
        protect: true,
        summary:
          "The Harness Profile and Executor Profile a new Task starts with. Either is null when none is chosen, or when the one that was chosen has since been deleted.",
      },
    })
    .input(z.object({}))
    .output(taskDefaultsDto)
    .query(async ({ ctx }) => unwrap(await getTaskDefaults(ctx.rctx))),

  setTaskDefaults: workspaceControlsProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/preference.setTaskDefaults",
        tags: ["preference"],
        protect: true,
        summary:
          "Choose the Harness Profile and Executor Profile a new Task starts with. Null on either clears it. Refuses a Profile this Workspace does not own.",
      },
    })
    .input(setTaskDefaultsInput)
    .output(taskDefaultsDto)
    .mutation(async ({ ctx, input }) => unwrap(await setTaskDefaults(ctx.rctx, input))),
});
