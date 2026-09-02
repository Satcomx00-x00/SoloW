import "server-only";
import { streamTicketDto, streamTicketInput } from "@solow/contracts";
import { STREAM_TICKET_TTL_MS, signStreamTicket } from "@solow/core/stream";
import { getTaskById } from "../dal/task.js";
import { webEnv } from "../env.js";
import { ownerProcedure, router, unwrap } from "../trpc.js";

/**
 * Realtime subscription tickets (TASK-018). The hub runs in the orchestrator process and has
 * no access to the web session, so authorization happens here — session + Workspace ownership
 * are checked, then a short-lived signed ticket naming one channel is handed to the client.
 * The tenant key is inside the signed claims, never a client parameter (Principle V).
 */
/**
 * Hostnames that mean "the machine this is running on" rather than a place on the network.
 *
 * `[::1]` with the brackets, because that is what `URL.hostname` returns for an IPv6 literal —
 * the bare `::1` never matches and the placeholder would be honoured as though it were a real
 * address.
 */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/**
 * Where the browser should dial the hub.
 *
 * `SOLOW_WS_URL` is `ws://localhost:5001` on every local install, and that is correct for
 * exactly one browser: one running on the same machine. Open the same install from a phone or
 * another laptop — at the network address Next itself prints on every boot — and this URL sends
 * that browser to *its own* localhost:5001, where nothing is listening. The socket fails, the
 * hook backs off and retries for ever, and every live surface in the app silently stops being
 * live while looking perfectly normal.
 *
 * So a loopback host in the configuration is read as what it is: a stand-in for "wherever this
 * is running", resolved against the host the client demonstrably just reached us on. The port
 * and scheme still come from the configuration, because those are real choices — only the
 * placeholder hostname is filled in.
 *
 * A configured host that is *not* loopback is honoured exactly as written. That is a deployment
 * stating where its hub actually lives, which this must never second-guess.
 */
export function hubUrlFor(configured: string, requestHost: string | null): URL {
  const url = new URL(configured);
  if (!requestHost || !LOOPBACK.has(url.hostname)) return url;
  // `URL` needs a scheme to parse a bare `host:port`; the result's hostname is all that is used.
  const from = URL.parse(`http://${requestHost}`);
  if (!from || LOOPBACK.has(from.hostname)) return url;
  url.hostname = from.hostname;
  return url;
}

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
        webEnv().SOLOW_STREAM_SECRET,
        now,
      );
      const url = hubUrlFor(webEnv().SOLOW_WS_URL, ctx.requestHost ?? null);
      url.searchParams.set("ticket", ticket);
      return {
        url: url.toString(),
        expiresAt: new Date(now + STREAM_TICKET_TTL_MS).toISOString(),
      };
    }),
});
