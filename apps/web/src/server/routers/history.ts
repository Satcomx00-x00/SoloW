import "server-only";
import { historyListDto } from "@solow/contracts";
import { z } from "zod";
import { listHistory } from "../dal/history.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

/**
 * History (spec F02 FR-10, F11; Decision 0025): the Tasks closed or deleted inside the
 * retention window. Read-only — restoring, reopening and relaunching are `task.*` procedures,
 * so the rules that guard them are stated once.
 */
export const historyRouter = router({
  list: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/history.list",
        tags: ["history"],
        protect: true,
        summary:
          "Tasks closed or deleted in the last seven days, newest first, each with when it leaves History and whether a relaunch would continue its conversation.",
      },
    })
    .input(z.object({}))
    .output(historyListDto)
    .query(async ({ ctx }) => unwrap(await listHistory(ctx.rctx))),
});
