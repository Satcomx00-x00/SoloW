import { Inngest } from "inngest";

/**
 * Inngest client for the durable orchestration workflows (Decision 0004).
 *
 * Which engine this talks to is Inngest's own contract, not ours: the SDK reads its well-known
 * `INNGEST_DEV` env var internally (unset or falsy → Inngest Cloud, using `INNGEST_EVENT_KEY` /
 * `INNGEST_SIGNING_KEY`; set → the local Dev Server, default `http://localhost:8288`). Deliberately
 * not wrapped in a `SOLOW_`-prefixed variable — that would be a second name for a
 * third-party SDK's own switch, and `scripts/dev.sh` already exports `INNGEST_DEV=1` for local runs.
 */
export const inngest = new Inngest({ id: "solow-orchestrator" });
