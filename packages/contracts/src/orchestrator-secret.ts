/**
 * `SOLOW_ORCHESTRATOR_SECRET`: the bearer secret the web app presents on the orchestrator's
 * `POST /events` (FINDINGS B3). One rule, read by both ends, because the two used to disagree:
 * the web app accepted a one-character value the orchestrator refused to boot with.
 *
 * A value that breaks the rule is treated as not configured, on both sides — the web app sends
 * no header and the orchestrator answers `/events` with 503 and says why. That closes the one
 * route the secret guards and leaves the rest of the orchestrator (the hub, the terminal, runs
 * already underway) standing, where a parse failure at boot took all of it down.
 *
 * Sixteen characters is a floor against a typo or a placeholder, not a strength rule: the
 * launchers generate 32 random bytes.
 */
export const ORCHESTRATOR_SECRET_MIN_LENGTH = 16;

export type OrchestratorSecretReading =
  | { ok: true; secret: string }
  | { ok: false; problem: "missing" | "too_short" };

export function readOrchestratorSecret(raw: string | undefined): OrchestratorSecretReading {
  if (!raw) return { ok: false, problem: "missing" };
  if (raw.length < ORCHESTRATOR_SECRET_MIN_LENGTH) return { ok: false, problem: "too_short" };
  return { ok: true, secret: raw };
}

/** The sentence an operator reads, on either side, when the secret cannot be used. */
export function orchestratorSecretProblem(problem: "missing" | "too_short"): string {
  return problem === "missing"
    ? "SOLOW_ORCHESTRATOR_SECRET is not configured"
    : `SOLOW_ORCHESTRATOR_SECRET must be at least ${ORCHESTRATOR_SECRET_MIN_LENGTH} characters`;
}
