import { handleTrpcRequest } from "@/server/http";

/**
 * tRPC-over-HTTP route handler (Decision 0011). A thin Next wrapper delegating to the
 * framework-agnostic fetch handler. Runs on the Node/Bun server runtime (the DAL uses
 * `bun:sqlite`, so the app is served under `bun --bun`).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function handler(req: Request): Promise<Response> {
  return handleTrpcRequest(req);
}

export { handler as GET, handler as POST };
