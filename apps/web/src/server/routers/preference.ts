import "server-only";
import {
  getSurfaceLayoutInput,
  setSurfaceLayoutInput,
  surfaceLayoutDto,
} from "@gatecontrol/contracts";
import { getSurfaceLayout, setSurfaceLayout } from "../dal/preference.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

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
});
