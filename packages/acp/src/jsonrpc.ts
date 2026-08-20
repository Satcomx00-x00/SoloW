/**
 * JSON-RPC 2.0 framed as newline-delimited JSON — ACP's transport (Decision 0003).
 *
 * Kept separate from `session.ts` because framing is where the interesting failures live: a
 * JSON object straddling a read boundary, a response arriving for a request nobody is waiting
 * on, a child dying with three requests outstanding. Those are testable here on their own; a
 * session-level test would hide them behind a passing handshake.
 *
 * Nothing in this module knows what ACP is, and nothing in it touches a process — the caller
 * supplies `write` and pumps bytes in through `feed`.
 */

export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** An error carrying a JSON-RPC code, so a handler can refuse a method with the right one. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * Parse one line. Returns null for blank lines, unparseable JSON, and JSON that is not a
 * JSON-RPC message.
 *
 * Deliberately permissive, for the same reason `parseStreamLine` is in the Claude Code package:
 * an agent is a separate product on its own release cadence, and a stray line on stdout — a
 * banner, a progress spinner, a deprecation notice — must not end a run that is otherwise fine.
 */
export function parseJsonRpcMessage(line: string): JsonRpcMessage | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const msg = raw as Record<string, unknown>;
  if (msg["jsonrpc"] !== "2.0") return null;

  const hasId = "id" in msg && (typeof msg["id"] === "number" || typeof msg["id"] === "string");
  if (typeof msg["method"] === "string") {
    return hasId
      ? ({
          jsonrpc: "2.0",
          id: msg["id"] as JsonRpcId,
          method: msg["method"],
          params: msg["params"],
        } satisfies JsonRpcRequest)
      : ({
          jsonrpc: "2.0",
          method: msg["method"],
          params: msg["params"],
        } satisfies JsonRpcNotification);
  }
  if (!hasId) return null;
  const response: JsonRpcResponse = { jsonrpc: "2.0", id: msg["id"] as JsonRpcId };
  if ("result" in msg) response.result = msg["result"];
  const err = msg["error"];
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    response.error = {
      code: typeof e["code"] === "number" ? e["code"] : JsonRpcErrorCode.InternalError,
      message: typeof e["message"] === "string" ? e["message"] : "unknown error",
      data: e["data"],
    };
  }
  return response;
}

/** One message, framed. The trailing newline *is* the frame delimiter — never drop it. */
export function encodeMessage(msg: JsonRpcMessage): string {
  return `${JSON.stringify(msg)}\n`;
}

export interface JsonRpcPeerOptions {
  /** Write one already-framed line to the other side. */
  write: (line: string) => void;
  /**
   * Answer an incoming request. Throw a `JsonRpcError` to refuse with a specific code — that
   * is how a client says "I never advertised that capability" (AC-2). Absent, every incoming
   * request is answered `-32601`: silence would hang the peer forever.
   */
  onRequest?: (method: string, params: unknown, id: JsonRpcId) => Promise<unknown>;
  onNotify?: (method: string, params: unknown) => void;
}

/**
 * One side of a JSON-RPC conversation over a line-oriented byte stream.
 *
 * `close(cause)` is the important half: a child that dies mid-turn must reject every request
 * still outstanding, or the caller awaits a promise that can never settle and a durable step
 * hangs until its timeout instead of failing with a legible reason.
 */
export class JsonRpcPeer {
  private nextId = 1;
  private buffer = "";
  private closed: Error | null = null;
  private readonly waiting = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (cause: Error) => void }
  >();

  constructor(private readonly options: JsonRpcPeerOptions) {}

  /** Requests still awaiting a response. Exposed for tests and for close-time assertions. */
  get pending(): number {
    return this.waiting.size;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
    });
    this.options.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    return promise as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.options.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  /**
   * Feed decoded text in. Splits on newlines and keeps the trailing partial line for the next
   * call: a JSON object can straddle a read boundary, and parsing half of one loses the message.
   */
  feed(text: string): void {
    this.buffer += text;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.dispatch(line);
  }

  /** Reject everything outstanding. Idempotent — a close during teardown is normal. */
  close(cause: Error): void {
    if (this.closed) return;
    this.closed = cause;
    for (const [, entry] of this.waiting) entry.reject(cause);
    this.waiting.clear();
  }

  private dispatch(line: string): void {
    const msg = parseJsonRpcMessage(line);
    if (!msg) return;

    if ("method" in msg) {
      if (!("id" in msg)) {
        this.options.onNotify?.(msg.method, msg.params);
        return;
      }
      void this.answer(msg);
      return;
    }

    const entry = this.waiting.get(msg.id);
    // A response for an id nobody is waiting on: a duplicate, or a reply arriving after
    // `close`. Dropping it is right — resolving something twice would be worse.
    if (!entry) return;
    this.waiting.delete(msg.id);
    if (msg.error) {
      entry.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data));
      return;
    }
    entry.resolve(msg.result);
  }

  private async answer(request: JsonRpcRequest): Promise<void> {
    try {
      if (!this.options.onRequest) {
        throw new JsonRpcError(
          JsonRpcErrorCode.MethodNotFound,
          `method not found: ${request.method}`,
        );
      }
      const result = await this.options.onRequest(request.method, request.params, request.id);
      this.options.write(encodeMessage({ jsonrpc: "2.0", id: request.id, result }));
    } catch (cause) {
      const error =
        cause instanceof JsonRpcError
          ? { code: cause.code, message: cause.message }
          : {
              code: JsonRpcErrorCode.InternalError,
              // The message, never the stack or the params: a request's params can carry the
              // content of a file the agent is editing (Principle IV).
              message: cause instanceof Error ? cause.message : String(cause),
            };
      this.options.write(encodeMessage({ jsonrpc: "2.0", id: request.id, error }));
    }
  }
}
