import "server-only";
import { type Db, workspace } from "@solow/db";

/**
 * The web app's own liveness (FINDINGS F3), for `GET /api/health`.
 *
 * Its own answer and nothing else's: the orchestrator has a `/health` of its own, and the status
 * bar reads both through `health.status`. A web app that answers but cannot read its database is
 * not serving anyone, so the one dependency checked here is that read.
 */
export interface WebHealthReport {
  status: "ok" | "error";
  service: "web";
  database: "ok" | "unreachable";
}

/** `open` rather than a handle, so a database that cannot even be opened is a 503 and not a 500. */
export async function webHealth(open: () => Pick<Db, "select">): Promise<WebHealthReport> {
  try {
    await open().select({ id: workspace.id }).from(workspace).limit(1);
    return { status: "ok", service: "web", database: "ok" };
  } catch {
    return { status: "error", service: "web", database: "unreachable" };
  }
}
