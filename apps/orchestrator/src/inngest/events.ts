import { createHash, timingSafeEqual } from "node:crypto";
import { orchestratorSecretProblem, readOrchestratorSecret } from "@solow/contracts";
import { createLogger } from "@solow/observability";
import { z } from "zod";
import { orchestratorEnv } from "../env.js";
import { inngest } from "./client.js";

/**
 * Envelope for `POST /events` — the transport `apps/web/src/server/orchestrator-client.ts`'s
 * `emit()` already speaks, and the same shape Inngest's own event API uses (Decision 0004).
 *
 * Deliberately shallow: `data`'s actual contents (`task.launch.requested`'s launch payload, and
 * the review decision a run is started with) are `task-run.ts`'s own `launchData` schema to
 * validate, which this module must not duplicate or drift from (it is wiring-only). A malformed
 * `data` surfaces as a failed function run in the Dev Server / Inngest Cloud, the same place it
 * would in a hosted deployment — not as a 400 here.
 */
const eventEnvelopeSchema = z.object({
  name: z.string().min(1),
  data: z.record(z.unknown()),
});

/**
 * Just the piece of the Inngest client this module needs, injectable so a test can assert the
 * handoff without a real Dev Server listening and without racing the singleton `inngest`
 * client's own env snapshot (taken once, at import time) against every other test file in the
 * suite that also imports `./client.js`.
 */
export interface EventPostDeps {
  send: (payload: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
  /**
   * The secret the web app must present as `Authorization: Bearer <secret>`, as configured.
   * Unset, or failing the shared rule (`readOrchestratorSecret`), and the route refuses
   * everything with a 503: an open `/events` lets anyone who can reach the port start a run
   * (FINDINGS B3).
   */
  secret?: string | undefined;
}

function defaultEventPostDeps(): EventPostDeps {
  return {
    send: (payload) => inngest.send(payload),
    secret: orchestratorEnv().SOLOW_ORCHESTRATOR_SECRET,
  };
}

/** Said once per process: the 503 repeats on every request, the log line need not. */
let secretProblemLogged = false;

/** Constant-time compare, so the secret cannot be recovered a byte at a time from response timing. */
function bearerMatches(header: string | null, secret: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * `POST /events` handler (Decision 0004): the one thing standing between the web app's
 * `enqueueTaskRun()` / `applyReview()` and the durable engine actually receiving the event.
 * Returns 202 on a successful `send()` — matching the 202 the e2e fake orchestrator's own
 * `/events` route already returns, so `orchestrator-client.ts`'s `if (!res.ok) throw` behaves
 * identically against either backend.
 */
export async function handleEventPost(
  req: Request,
  deps: EventPostDeps = defaultEventPostDeps(),
): Promise<Response> {
  const configured = readOrchestratorSecret(deps.secret);
  if (!configured.ok) {
    const reason = orchestratorSecretProblem(configured.problem);
    if (!secretProblemLogged) {
      secretProblemLogged = true;
      createLogger({ service: "orchestrator" }).error(
        `POST /events refuses every request: ${reason}. Runs cannot be started until it is set.`,
      );
    }
    // The caller is not authenticated yet, so it learns only that the route is closed; the rule
    // the secret broke is in the log above, for the operator.
    return new Response("not accepting events", { status: 503 });
  }
  if (!bearerMatches(req.headers.get("authorization"), configured.secret)) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("invalid json body", { status: 400 });
  }

  const parsed = eventEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(`malformed event envelope: ${parsed.error.message}`, { status: 400 });
  }

  try {
    await deps.send({ name: parsed.data.name, data: parsed.data.data });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return new Response(`inngest.send failed: ${message}`, { status: 502 });
  }

  return new Response(null, { status: 202 });
}
