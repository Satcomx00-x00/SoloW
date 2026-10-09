import { Inngest } from "inngest";

/**
 * Inngest client for the durable orchestration workflows (Decision 0004).
 *
 * Which engine this talks to is Inngest's own contract, not ours: the SDK reads its well-known
 * variables internally. `INNGEST_DEV` set means a Dev Server with signature checks skipped;
 * unset, it signs with `INNGEST_SIGNING_KEY`, sends with `INNGEST_EVENT_KEY`, and goes to Inngest
 * Cloud unless `INNGEST_BASE_URL` names another server. Deliberately not wrapped in
 * `SOLOW_`-prefixed variables — those would be second names for a third-party SDK's own switches.
 * `scripts/lib/engine-env.sh` sets them for `dev.sh` and `start.sh`: it unsets `INNGEST_DEV`
 * and points `INNGEST_BASE_URL` at the self-hosted, signed `inngest start`.
 */
export const inngest = new Inngest({ id: "solow-orchestrator" });
