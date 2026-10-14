import "server-only";
import { outcomesDto, outcomesInput } from "@solow/contracts";
import { workspaceOutcomes } from "../dal/outcomes.js";
import { outcomesProcedure, router, unwrap } from "../trpc.js";

/**
 * Outcomes (finding A4, spec F14): whether the product works, from what it already records.
 * Read-only, and every figure is defined on `outcomesDto`.
 */
export const outcomesRouter = router({
  get: outcomesProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/outcomes.get",
        tags: ["outcomes"],
        protect: true,
        summary:
          "Tasks shipped per week, run-to-approval rate, attempts per Task, and token spend per Task, Harness Profile and billing mode, over the last N weeks (Monday-based, UTC). Deleted Tasks are left out.",
      },
    })
    .input(outcomesInput)
    .output(outcomesDto)
    .query(async ({ ctx, input }) => unwrap(await workspaceOutcomes(ctx.rctx, input))),
});
