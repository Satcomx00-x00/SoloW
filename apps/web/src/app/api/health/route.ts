import { createDb } from "@solow/db";
import { webHealth } from "@/server/health";

/**
 * Liveness for the web app (FINDINGS F3): 200 while it can serve, 503 when its database read
 * fails. Unauthenticated like any health route; it answers with no Workspace data.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const report = await webHealth(createDb);
  return Response.json(report, {
    status: report.status === "ok" ? 200 : 503,
    headers: { "cache-control": "no-store" },
  });
}
