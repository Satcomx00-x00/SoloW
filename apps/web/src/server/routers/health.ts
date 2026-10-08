import "server-only";
import { attentionListDto, systemHealthDto, workspaceDto } from "@solow/contracts";
import { listRunsNeedingAttention } from "../dal/attention.js";
import { orchestrator } from "../orchestrator-client.js";
import { ownerProcedure, router, sessionProcedure, unwrap } from "../trpc.js";

/**
 * The product's own health, as the status bar shows it (FINDINGS F3).
 *
 * `status` is on `sessionProcedure`, not behind the core flag: whether the services are up is
 * worth knowing most when something is off, and it reads no Workspace data at all.
 */
export const healthRouter = router({
  status: sessionProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/health.status",
        tags: ["health"],
        protect: true,
        summary:
          "Whether the orchestrator answers, and whether the durable engine behind it does. Never fails: an outage is reported in the answer.",
      },
    })
    .input(workspaceDto.pick({}).optional())
    .output(systemHealthDto)
    .query(() => orchestrator.health()),

  attention: ownerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/health.attention",
        tags: ["health"],
        protect: true,
        summary:
          "Tasks whose run failed or is stuck (running and silent, parked past its wake-up, a review decision never applied), newest first, with when the list next changes by the clock alone.",
      },
    })
    .input(workspaceDto.pick({}).optional())
    .output(attentionListDto)
    .query(async ({ ctx }) => unwrap(await listRunsNeedingAttention(ctx.rctx))),
});
