import { InngestCommHandler } from "inngest";
import { inngest } from "./client.js";
import { repositorySync } from "./functions/repository-sync.js";
import { taskRun } from "./functions/task-run.js";

/**
 * The one list of functions Inngest actually knows about — every function this process runs must
 * be in it, or Inngest can never discover it.
 *
 * Single source of truth on purpose (bug found 2026-08-27, user-reported: a GitLab repository's
 * Issues never synced). `repositorySync` (issue #125's cron) was registered in `index.ts`'s own
 * `functions` export and nowhere else — that export is only ever read for a boot-time log line
 * (`main.ts`'s `${functions.length} Inngest function(s) registered`), never passed to the actual
 * handler below, which had its own separate, hand-kept `[taskRun]` literal that nothing kept in
 * sync with the first one. The log line said "2 functions registered" while Inngest itself,
 * queried directly, reported one — `repositorySync`'s cron had never fired, for any provider,
 * since the feature was introduced. `index.ts` now imports this constant rather than building its
 * own list, so there is exactly one place a function can be added and forgotten from the other.
 */
export const INNGEST_FUNCTIONS = [taskRun, repositorySync];

/**
 * The `/api/inngest` handler (Decision 0004), **streaming**.
 *
 * Inngest executes a function by making an HTTP request per step and waiting for the response.
 * That model assumes steps are short. `task-run`'s central step is not: `agent-run-${round}`
 * holds an agent process for as long as the agent takes to do the work, which is minutes at
 * best. The request outlives the platform's execution budget, the platform gives up, and the
 * step's result is never checkpointed.
 *
 * That failure is silent in the worst way, and it is the one observed end to end on 2026-08-27:
 * the agent really did edit the file, its output really was streamed to the browser and written
 * to the session log — every side effect of the step landed — while the *step* was recorded as
 * failed. Inngest then retried it from the top, so the run never reached the review gate, never
 * parked at `waitForEvent`, and the `review.decided` event published on approval arrived at a
 * run that was not listening. The trace tells the story exactly: `Attempt 0` FAILED after
 * 8m 07s with `Unable to reach SDK URL`, `Attempt 1` running.
 *
 * Streaming is the SDK's own answer to this and says so in its options: *"may support streaming
 * responses back to Inngest. This can be used to circumvent restrictive request timeouts."* The
 * handler sends preliminary headers immediately and holds the connection open, so the request
 * budget stops being the ceiling on how long a step may take.
 *
 * **Built here rather than taken from `inngest/bun`.** That adapter delegates to the edge one,
 * whose `createWebApiCommHandler` implements `transformResponse` and *not*
 * `transformStreamingResponse` — so `streaming: true` through `serve()` throws rather than
 * streams. This is the same Web-API request/response shape it builds, plus the one transform it
 * leaves out; `inngest/remix` shows the pattern, using the identical `Response` constructor for
 * both. Nothing about the request handling differs, so the route in `index.ts` is unchanged.
 *
 * This raises the ceiling; it does not remove it. A streaming step still ends at the platform's
 * hard function limit, so an agent that runs for hours will eventually meet the same wall. The
 * durable answer is for the run not to *hold* the agent at all — start it in one step, and park
 * on an event the supervising process publishes when it ends — which is a restructure of the
 * lifecycle rather than a change to how it is served.
 */
export const inngestServeHandler = new InngestCommHandler({
  frameworkName: "bun",
  client: inngest,
  functions: INNGEST_FUNCTIONS,
  streaming: true,
  handler: (req: Request) => ({
    body: () => req.text(),
    headers: (key: string) => req.headers.get(key),
    method: () => req.method,
    url: () => new URL(req.url, `https://${req.headers.get("host") || ""}`),
    transformResponse: ({
      body,
      status,
      headers,
    }: {
      body: string;
      status: number;
      headers: Record<string, string>;
    }) => new Response(body, { status, headers }),
    // The half `inngest/bun` omits, and the whole reason this file exists.
    transformStreamingResponse: ({
      body,
      status,
      headers,
    }: {
      // A `ReadableStream` here rather than the string the non-streaming transform gets — that
      // is the whole difference, and it is what keeps the connection open.
      body: ReadableStream | string;
      status: number;
      headers: Record<string, string>;
    }) => new Response(body, { status, headers }),
  }),
}).createHandler();
