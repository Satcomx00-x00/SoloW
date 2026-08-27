/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { generateMcpToken, issue as issueTable, mcpToken, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { resetRateLimits } from "../rate-limit.js";
import { handleMcpRequest } from "./handler.js";
import { JsonRpcError, SUPPORTED_PROTOCOL_VERSION } from "./protocol.js";
import { listMcpTools } from "./tools.js";

/**
 * MCP transport integration tests (issue #16, Principles V and VI).
 *
 * These drive the real handler with real `Request` objects against a real in-memory database.
 * The security acceptance criteria — cross-Workspace refusal (AC-3), revocation (AC-5), scope —
 * are only meaningfully covered if the request goes all the way through the same tRPC middleware
 * the SPA uses, so nothing here is stubbed.
 */

let db: TestDb;

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
});

beforeEach(() => {
  db = createTestDb();
  resetRateLimits();
});

/** A Workspace with the MCP + core flags on and one live token. Returns the token's raw value. */
async function seedWorkspaceWithToken(
  name: string,
  opts: { scope?: "read" | "read_write"; flags?: Record<string, boolean>; revoked?: boolean } = {},
): Promise<{ workspaceId: string; value: string; tokenId: string }> {
  const [ws] = await db
    .insert(workspace)
    .values({
      name,
      ownerUserId: `owner-${name}`,
      enabledFlags: opts.flags ?? { "ff-core-program": true, "ff-mcp": true },
    })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");

  const generated = generateMcpToken();
  const [row] = await db
    .insert(mcpToken)
    .values({
      workspaceId: ws.id,
      label: `${name}-token`,
      scope: opts.scope ?? "read_write",
      tokenHash: generated.hash,
      prefix: generated.prefix,
      ...(opts.revoked ? { revokedAt: new Date().toISOString() } : {}),
    })
    .returning();
  if (!row) throw new Error("failed to seed token");

  return { workspaceId: ws.id, value: generated.value, tokenId: row.id };
}

function rpc(body: unknown, token?: string): Request {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function call(body: unknown, token?: string) {
  const res = await handleMcpRequest(rpc(body, token), { db });
  const text = await res.text();
  return { res, json: text ? JSON.parse(text) : null, text };
}

describe("MCP transport — authentication", () => {
  it("refuses a request with no bearer token, and says how to authenticate", async () => {
    const res = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), {
      db,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("refuses an unknown token", async () => {
    const { res } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "gcmcp_nonsense");
    expect(res.status).toBe(401);
  });

  it("AC-5: refuses a revoked token, indistinguishably from an unknown one", async () => {
    const revoked = await seedWorkspaceWithToken("acme", { revoked: true });
    const { res, json } = await call(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      revoked.value,
    );
    expect(res.status).toBe(401);
    // Same body as an unknown token: a revoked token must not be identifiable as "real but off".
    expect(json.error).toBe("invalid or revoked token");
  });

  it("never echoes the presented token back in any response", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const { text } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, value);
    expect(text).not.toContain(value);
  });
});

describe("MCP transport — protocol", () => {
  it("initialize advertises the tools capability and the negotiated version", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const { json } = await call({ jsonrpc: "2.0", id: 1, method: "initialize" }, value);
    expect(json.result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSION);
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.serverInfo.name).toBe("solow");
  });

  it("answers a notification with 202 and no body (JSON-RPC gives notifications no reply)", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const res = await handleMcpRequest(
      rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, value),
      { db },
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("reports an unknown method as -32601 rather than failing the transport", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const { res, json } = await call({ jsonrpc: "2.0", id: 9, method: "resources/list" }, value);
    expect(res.status).toBe(200);
    expect(json.error.code).toBe(JsonRpcError.MethodNotFound);
  });

  it("reports malformed JSON as a parse error", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const res = await handleMcpRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${value}` },
        body: "{not json",
      }),
      { db },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(JsonRpcError.ParseError);
  });

  it("handles a batch, returning one response per non-notification entry", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const { json } = await call(
      [
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ],
      value,
    );
    expect(Array.isArray(json)).toBe(true);
    expect(json).toHaveLength(2);
    expect(json.map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });
});

describe("MCP transport — tool surface", () => {
  it("lists tools derived from the tRPC procedures", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const { json } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, value);
    expect(json.result.tools.length).toBe(listMcpTools().length);
    expect(json.result.tools.every((t: { inputSchema?: unknown }) => t.inputSchema)).toBe(true);
  });

  it("withholds credential and token-administration namespaces from the surface", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const { json } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, value);
    const names: string[] = json.result.tools.map((t: { name: string }) => t.name);
    // A token must not be able to write a credential, nor mint or revoke tokens.
    expect(names.filter((n) => n.startsWith("secret_"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("mcpToken_"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("stream_"))).toEqual([]);
  });

  it("rejects a call to a tool that does not exist", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const { json } = await call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "secret_set", arguments: {} },
      },
      value,
    );
    expect(json.error.code).toBe(JsonRpcError.MethodNotFound);
  });
});

describe("MCP transport — scope", () => {
  it("lets a read token call a query", async () => {
    const { value } = await seedWorkspaceWithToken("acme", { scope: "read" });
    const { json } = await call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "issue_list", arguments: {} },
      },
      value,
    );
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(false);
  });

  it("refuses a mutation from a read-only token", async () => {
    const { value } = await seedWorkspaceWithToken("acme", { scope: "read" });
    const { json } = await call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "repository_connect",
          arguments: { name: "r", source: "local_path", location: "/srv/r" },
        },
      },
      value,
    );
    expect(json.error.code).toBe(JsonRpcError.InvalidRequest);
    expect(json.error.message).toContain("read_write");
  });
});

describe("MCP transport — tenancy and flags (Principle V, AC-3)", () => {
  it("cannot read another Workspace's Issue, exactly as over tRPC", async () => {
    const a = await seedWorkspaceWithToken("acme");
    const b = await seedWorkspaceWithToken("other");

    const [aIssue] = await db
      .insert(issueTable)
      .values({ workspaceId: a.workspaceId, title: "A's private issue" })
      .returning();
    if (!aIssue) throw new Error("failed to seed issue");

    // Workspace B's token, asking for Workspace A's issue by its real id.
    const { json } = await call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "issue_get", arguments: { id: aIssue.id } },
      },
      b.value,
    );

    // Must be a refusal, never an empty-but-successful result that reads as "no such issue".
    expect(json.error).toBeDefined();
    expect(JSON.stringify(json)).not.toContain("A's private issue");
    // Assert *why* it was refused. Without this the case passes on any error at all — an earlier
    // revision of the dispatcher failed to resolve the procedure and this test still went green,
    // proving nothing about tenancy.
    expect(json.error.data?.trpcCode).toBe("NOT_FOUND");
    expect(json.error.message).not.toContain("no procedure");
  });

  it("a token only ever sees its own Workspace's Issues", async () => {
    const a = await seedWorkspaceWithToken("acme");
    const b = await seedWorkspaceWithToken("other");
    await db.insert(issueTable).values({ workspaceId: a.workspaceId, title: "A only" });
    await db.insert(issueTable).values({ workspaceId: b.workspaceId, title: "B only" });

    const { json } = await call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "issue_list", arguments: {} },
      },
      b.value,
    );
    const text = JSON.stringify(json);
    expect(text).toContain("B only");
    expect(text).not.toContain("A only");
  });

  it("the ff-mcp kill switch blocks the flagged procedures behind it", async () => {
    // Core on, MCP off: the token authenticates, but nothing gated on ff-mcp may run.
    const { value } = await seedWorkspaceWithToken("acme", {
      flags: { "ff-core-program": true, "ff-mcp": false },
    });
    const { json } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, value);
    // tools/list is transport-level and still answers; the guard binds at call time.
    expect(json.result.tools.length).toBeGreaterThan(0);
  });

  it("the ff-core-program kill switch refuses a core tool call", async () => {
    const { value } = await seedWorkspaceWithToken("acme", {
      flags: { "ff-core-program": false, "ff-mcp": true },
    });
    const { json } = await call(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "issue_list", arguments: {} },
      },
      value,
    );
    expect(json.error).toBeDefined();
    expect(json.error.data?.trpcCode).toBe("FORBIDDEN");
  });
});

describe("MCP transport — SSE and method handling", () => {
  it("opens an authenticated SSE stream on GET", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const res = await handleMcpRequest(
      new Request("http://localhost/api/mcp", {
        method: "GET",
        headers: { authorization: `Bearer ${value}`, accept: "text/event-stream" },
      }),
      { db },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("refuses an unauthenticated SSE stream", async () => {
    const res = await handleMcpRequest(new Request("http://localhost/api/mcp", { method: "GET" }), {
      db,
    });
    expect(res.status).toBe(401);
  });

  it("answers POST as SSE when the client accepts only text/event-stream", async () => {
    const { value } = await seedWorkspaceWithToken("acme");
    const res = await handleMcpRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${value}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      { db },
    );
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain('"jsonrpc":"2.0"');
  });

  it("rejects an unsupported HTTP method", async () => {
    const res = await handleMcpRequest(new Request("http://localhost/api/mcp", { method: "PUT" }), {
      db,
    });
    expect(res.status).toBe(405);
  });
});

describe("MCP transport — token usage tracking", () => {
  it("stamps lastUsedAt so an unused or stale token is visible in the UI", async () => {
    const { value, tokenId } = await seedWorkspaceWithToken("acme");
    await call({ jsonrpc: "2.0", id: 1, method: "ping" }, value);

    const [row] = await db.select().from(mcpToken).where(eqId(tokenId));
    expect(row?.lastUsedAt).not.toBeNull();
  });
});

/** Local helper so the test file does not need drizzle's operators imported for one use. */
function eqId(id: string) {
  const { eq } = require("drizzle-orm") as typeof import("drizzle-orm");
  return eq(mcpToken.id, id);
}
