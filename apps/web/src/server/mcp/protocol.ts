import "server-only";
import type { McpScope } from "@solow/contracts";
import { TRPCError } from "@trpc/server";
import { appRouter } from "../routers/index.js";
import type { BaseContext } from "../trpc.js";
import { scopeAllows } from "./auth.js";
import { findMcpTool, listMcpTools } from "./tools.js";

/**
 * MCP's JSON-RPC layer (issue #16 AC-1), kept free of HTTP so every branch — including the
 * error branches that matter most — is testable against plain objects.
 *
 * Only the tools half of MCP is implemented. SoloW has no prompts, resources, or sampling
 * to offer, and advertising capabilities the server does not have makes clients probe endpoints
 * that will only ever fail.
 */

/** Negotiated against the client's request; this is the revision the tool surface is written to. */
export const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";

const SERVER_INFO = { name: "solow", version: "0.1.0" } as const;

/** JSON-RPC 2.0 error codes (the spec's reserved range). */
export const JsonRpcError = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  /** Absent on a notification, which by spec gets no reply at all. */
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && typeof candidate.method === "string";
}

/** A notification has no `id` and must produce no response (JSON-RPC 2.0 §4.1). */
export function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

/**
 * Map a tRPC failure onto JSON-RPC.
 *
 * A denial has to stay a denial: `UNAUTHORIZED`/`FORBIDDEN` from the flag guard or a tenancy
 * check surfaces as an error response, never as an empty-but-successful result that a client
 * would read as "no such data" (which is how a scoping bug becomes invisible).
 */
function fromTrpcError(id: string | number | null, cause: unknown): JsonRpcResponse {
  if (cause instanceof TRPCError) {
    const code =
      cause.code === "BAD_REQUEST" ? JsonRpcError.InvalidParams : JsonRpcError.InternalError;
    return fail(id, code, cause.message, { trpcCode: cause.code });
  }
  // Never surface an unexpected error's text: it can carry internals the caller should not see.
  return fail(id, JsonRpcError.InternalError, "internal error");
}

export interface DispatchDeps {
  ctx: BaseContext;
  scope: McpScope;
}

/**
 * Execute one JSON-RPC request. Returns null for a notification (nothing to send back).
 */
export async function dispatch(
  req: JsonRpcRequest,
  deps: DispatchDeps,
): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null;
  if (isNotification(req)) {
    // `notifications/initialized` and friends are acknowledged by silence, per JSON-RPC.
    return null;
  }

  switch (req.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, {
        tools: listMcpTools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });

    case "tools/call":
      return callTool(id, req.params, deps);

    default:
      return fail(id, JsonRpcError.MethodNotFound, `unknown method: ${req.method}`);
  }
}

async function callTool(
  id: string | number | null,
  params: unknown,
  deps: DispatchDeps,
): Promise<JsonRpcResponse> {
  const parsed = (params ?? {}) as { name?: unknown; arguments?: unknown };
  if (typeof parsed.name !== "string") {
    return fail(id, JsonRpcError.InvalidParams, "tools/call requires a string `name`");
  }

  const tool = findMcpTool(parsed.name);
  if (!tool) {
    return fail(id, JsonRpcError.MethodNotFound, `unknown tool: ${parsed.name}`);
  }

  // Scope is checked before dispatch so a `read` token cannot reach a mutation at all. The tRPC
  // middleware would still enforce tenancy, but it has no notion of token scope — that check
  // exists only here, which is exactly why it must not be skippable.
  if (!scopeAllows(deps.scope, tool.readOnly)) {
    return fail(
      id,
      JsonRpcError.InvalidRequest,
      `tool ${tool.name} requires a read_write token; this token is read-only`,
    );
  }

  try {
    // The whole point of AC-3: go in through the same caller the SPA uses, so session, feature
    // flag, rate limit, and Workspace ownership are enforced by one implementation, not two.
    const caller = appRouter.createCaller(deps.ctx);
    const result = await callProcedure(caller, tool.procedurePath, parsed.arguments ?? {});
    return ok(id, {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
      isError: false,
    });
  } catch (cause) {
    return fromTrpcError(id, cause);
  }
}

/**
 * Walk the caller down a dotted procedure path and invoke it.
 *
 * tRPC's caller is a proxy in which *every* node is a `function`, including the intermediate
 * routers — `typeof caller.issue` is "function", not "object". So the walk accepts both and only
 * the call itself distinguishes a procedure from a router. The path is never attacker-chosen:
 * `findMcpTool` has already matched it against the derived tool list, so an unknown tool is
 * refused before reaching here.
 */
async function callProcedure(caller: unknown, path: string, input: unknown): Promise<unknown> {
  let node: unknown = caller;
  for (const segment of path.split(".")) {
    if (node === null || (typeof node !== "object" && typeof node !== "function")) {
      throw new TRPCError({ code: "NOT_FOUND", message: `no procedure at ${path}` });
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== "function") {
    throw new TRPCError({ code: "NOT_FOUND", message: `no procedure at ${path}` });
  }
  return (node as (arg: unknown) => Promise<unknown>)(input);
}
