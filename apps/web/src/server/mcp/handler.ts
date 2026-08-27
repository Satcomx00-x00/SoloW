import "server-only";
import { createDb, type Db } from "@solow/db";
import { bearerFrom, resolveMcpPrincipal, stampTokenUsed } from "./auth.js";
import {
  dispatch,
  isJsonRpcRequest,
  isNotification,
  JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";

/**
 * Framework-agnostic MCP transport (issue #16 AC-1), mirroring `handleTrpcRequest` — the Next
 * route handler is a thin wrapper, and everything testable lives here behind plain
 * `Request`/`Response`.
 *
 * Implements MCP's Streamable HTTP binding: a POST carries JSON-RPC and is answered either as
 * `application/json` or as a single-message SSE stream, and a GET opens an SSE stream for
 * server-initiated messages. The official SDK's HTTP transports are written against Node's
 * `IncomingMessage`/`ServerResponse`, which App Router does not hand out; the surface needed for
 * a tools-only server is small enough that meeting the spec directly is less machinery than
 * bridging two request models, and it keeps the dependency count at zero.
 */

const JSON_HEADERS = { "content-type": "application/json" } as const;

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
} as const;

/**
 * `WWW-Authenticate` on a 401 so a client is told *how* to authenticate rather than left to
 * guess, which is what the MCP authorization spec expects of a protected endpoint.
 */
function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { ...JSON_HEADERS, "www-authenticate": 'Bearer realm="solow-mcp"' },
  });
}

function wantsEventStream(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  // Prefer JSON when the client will take either; SSE only when it is the sole acceptable type.
  return accept.includes("text/event-stream") && !accept.includes("application/json");
}

function sseFrom(payload: unknown): Response {
  const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/**
 * Injectable collaborators, mirroring `SessionDeps` — the tests drive a real in-memory database
 * through the real handler rather than mocking the transport, which is the only way the tenancy
 * and revocation cases prove anything.
 */
export interface McpHandlerDeps {
  db: Db;
}

/**
 * Authenticate, then dispatch. Every request re-resolves the token, so revoking one takes effect
 * on the next call rather than whenever some cache happens to expire (AC-5).
 */
export async function handleMcpRequest(
  req: Request,
  deps: McpHandlerDeps = { db: createDb() },
): Promise<Response> {
  if (req.method === "GET") return handleGet(req, deps);
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...JSON_HEADERS, allow: "GET, POST, DELETE" },
    });
  }

  const presented = bearerFrom(req.headers);
  if (!presented) return unauthorized("missing bearer token");

  const { db } = deps;
  const principal = await resolveMcpPrincipal(db, presented);
  // Unknown and revoked are the same answer on purpose — see resolveMcpPrincipal.
  if (!principal) return unauthorized("invalid or revoked token");

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return new Response(
      JSON.stringify(errorResponse(null, JsonRpcError.ParseError, "invalid JSON")),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  // Best-effort, and awaited so a serverless invocation cannot be frozen before it lands.
  await stampTokenUsed(db, principal.tokenId).catch(() => {});

  const dispatchDeps = { ctx: principal.ctx, scope: principal.scope };
  const batch = Array.isArray(payload) ? payload : [payload];
  if (batch.length === 0) {
    return new Response(
      JSON.stringify(errorResponse(null, JsonRpcError.InvalidRequest, "empty batch")),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  const responses: JsonRpcResponse[] = [];
  for (const entry of batch) {
    if (!isJsonRpcRequest(entry)) {
      responses.push(
        errorResponse(null, JsonRpcError.InvalidRequest, "not a JSON-RPC 2.0 request"),
      );
      continue;
    }
    const response = await dispatch(entry as JsonRpcRequest, dispatchDeps);
    if (response) responses.push(response);
  }

  // A body of nothing but notifications gets 202 with no content, per the Streamable HTTP binding.
  if (responses.length === 0) return new Response(null, { status: 202 });

  const body = Array.isArray(payload) ? responses : responses[0];
  return wantsEventStream(req)
    ? sseFrom(body)
    : new Response(JSON.stringify(body), { status: 200, headers: JSON_HEADERS });
}

/**
 * GET opens the server→client SSE stream.
 *
 * A tools-only server never initiates a message, so this stream carries only periodic comment
 * keep-alives. It exists because clients that follow the SSE half of the binding open it before
 * they will talk at all — answering 405 would turn a working server into an unusable one for
 * them. Authentication still applies: an unauthenticated stream would be a way to hold a
 * connection open without a token.
 */
async function handleGet(req: Request, deps: McpHandlerDeps): Promise<Response> {
  const presented = bearerFrom(req.headers);
  if (!presented) return unauthorized("missing bearer token");

  const principal = await resolveMcpPrincipal(deps.db, presented);
  if (!principal) return unauthorized("invalid or revoked token");

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          // The consumer went away between ticks; cancel() does the cleanup.
          if (timer) clearInterval(timer);
        }
      }, 15_000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export { isNotification };
