import { handleMcpRequest } from "@/server/mcp/handler";

/**
 * External MCP endpoint (issue #16). A thin Next wrapper delegating to the framework-agnostic
 * handler, exactly as the tRPC route does — the transport logic stays testable without Next.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export { handler as DELETE, handler as GET, handler as POST };
