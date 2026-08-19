import "server-only";
import { streamTicketDto, streamTicketInput } from "@gatecontrol/contracts";
import { STREAM_TICKET_TTL_MS, signStreamTicket } from "@gatecontrol/core/stream";
import { getTaskById } from "../dal/task.js";
import { webEnv } from "../env.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

/**
 * Realtime subscription tickets (TASK-018). The hub runs in the orchestrator process and has
 * no access to the web session, so authorization happens here — session + Workspace ownership
 * are checked, then a short-lived signed ticket naming one channel is handed to the client.
 * The tenant key is inside the signed claims, never a client parameter (Principle V).
 */
export const streamRouter = router({
  ticket: ownerProcedure
    .meta({ openapi: { method: "POST", path: "/stream.ticket", tags: ["stream"], protect: true } })
    .input(streamTicketInput)
    .output(streamTicketDto)
    .mutation(async ({ ctx, input }) => {
      // Task-scoped tickets require the Task to be in this Workspace; a cross-Workspace id
      // fails here as NOT_FOUND and never reaches the hub.
      if (input.taskId) unwrap(await getTaskById(ctx.rctx, input.taskId));

      const now = Date.now();
      const ticket = signStreamTicket(
        { workspaceId: ctx.rctx.workspaceId, taskId: input.taskId ?? null },
        webEnv().GATECONTROL_STREAM_SECRET,
        now,
      );
      const url = new URL(webEnv().GATECONTROL_WS_URL);
      url.searchParams.set("ticket", ticket);
      return {
        url: url.toString(),
        expiresAt: new Date(now + STREAM_TICKET_TTL_MS).toISOString(),
      };
    }),
});
