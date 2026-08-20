import { z } from "zod";
import { inngest } from "./client.js";

/**
 * Envelope for `POST /events` — the transport `apps/web/src/server/orchestrator-client.ts`'s
 * `emit()` already speaks, and the same shape Inngest's own event API uses (Decision 0004).
 *
 * Deliberately shallow: `data`'s actual contents (`task.launch.requested`'s launch payload,
 * `review.decided`'s decision) are `task-run.ts`'s own `launchData`/`reviewData` schemas to
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
}

function defaultEventPostDeps(): EventPostDeps {
  return { send: (payload) => inngest.send(payload) };
}

/**
 * `POST /events` handler (Decision 0004): the one thing standing between the web app's
 * `enqueueTaskRun()` / `resumeReview()` and the durable engine actually receiving the event.
 * Returns 202 on a successful `send()` — matching the 202 the e2e fake orchestrator's own
 * `/events` route already returns, so `orchestrator-client.ts`'s `if (!res.ok) throw` behaves
 * identically against either backend.
 */
export async function handleEventPost(
  req: Request,
  deps: EventPostDeps = defaultEventPostDeps(),
): Promise<Response> {
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
