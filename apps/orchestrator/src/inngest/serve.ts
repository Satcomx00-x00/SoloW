import { serve } from "inngest/bun";
import { inngest } from "./client.js";
import { taskRun } from "./functions/task-run.js";

/**
 * The `/api/inngest` handler (Decision 0004): `inngest/bun`'s `serve()` builds a plain
 * `(req: Request) => Promise<Response>`, which is exactly `Bun.serve`'s `fetch` shape, so it
 * drops straight into `index.ts`'s route table. The Dev Server (or, hosted, Inngest Cloud)
 * polls this endpoint to discover `taskRun` and forwards the runs it schedules back into it —
 * this file is what makes that discovery and invocation traffic land somewhere real.
 *
 * Imports `taskRun` directly from `./functions/task-run.js` rather than from `../index.js`,
 * which already re-exports it: `index.ts` will need to import this module to wire the route,
 * and importing back from it here would be a cycle.
 */
export const inngestServeHandler = serve({ client: inngest, functions: [taskRun] });
