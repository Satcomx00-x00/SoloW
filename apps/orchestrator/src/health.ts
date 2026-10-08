import type { OrchestratorHealthReport, ServiceHealthDto } from "@solow/contracts";

/**
 * `GET /health` (FINDINGS F3): the orchestrator is up if it answers, and it reports whether the
 * durable engine behind it does too — only this process knows that address, and a stack whose
 * engine is down looks healthy everywhere else until a run never starts.
 *
 * Unauthenticated on purpose, like any liveness route: a supervisor or the web app must be able
 * to ask without a ticket, and the answer carries no Task data, no secret and no address — only
 * whether two services answered, and the engine's error in a few words. Being open is also why
 * the engine probe is shared for a few seconds: one outbound request per inbound one would let
 * anyone who can reach the port make this process hammer the engine.
 */

/** How long the engine gets to answer before it is reported unreachable. */
export const ENGINE_PROBE_TIMEOUT_MS = 2_000;

/**
 * Where the engine answers health checks, or null where this deployment has no address to ask.
 *
 * The same resolution the Inngest SDK makes for events: `INNGEST_BASE_URL` (the self-hosted
 * server the launchers start), else `INNGEST_DEV` as a Dev Server URL or, when it is only a flag,
 * the Dev Server's default port. Neither set means Inngest Cloud, which is not this machine's to
 * probe.
 */
export function engineHealthUrl(env: {
  INNGEST_BASE_URL?: string | undefined;
  INNGEST_DEV?: string | undefined;
}): string | null {
  const base = env.INNGEST_BASE_URL || devServerUrl(env.INNGEST_DEV);
  return base ? new URL("/health", base).toString() : null;
}

function devServerUrl(flag: string | undefined): string | null {
  if (!flag || flag === "0" || flag === "false") return null;
  return /^https?:\/\//.test(flag) ? flag : "http://localhost:8288";
}

/** Ask the engine whether it is up. Resolves either way: a probe that threw would 500 `/health`. */
export async function probeEngine(
  url: string | null,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
  timeoutMs = ENGINE_PROBE_TIMEOUT_MS,
): Promise<ServiceHealthDto> {
  if (!url) return { state: "unknown", detail: "no engine address configured (hosted engine)" };
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { state: "ok", detail: null };
    return { state: "unreachable", detail: `engine answered ${res.status}` };
  } catch (cause) {
    const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
    return {
      state: "unreachable",
      detail: timedOut
        ? `engine did not answer within ${timeoutMs / 1000}s`
        : "engine refused the connection",
    };
  }
}

/** How long one engine probe answers for every `/health` request. */
export const ENGINE_PROBE_CACHE_MS = 5_000;

/**
 * Share one probe's answer for `ttlMs`, and one in-flight probe among the callers that arrive
 * while it runs. Five seconds is shorter than any supervisor's interval, so a check still sees
 * an outage within one tick of it starting.
 */
export function cachedProbe(
  probe: () => Promise<ServiceHealthDto>,
  ttlMs = ENGINE_PROBE_CACHE_MS,
  now: () => number = Date.now,
): () => Promise<ServiceHealthDto> {
  let last: { at: number; answer: Promise<ServiceHealthDto> } | null = null;
  return () => {
    if (last && now() - last.at < ttlMs) return last.answer;
    last = { at: now(), answer: probe() };
    return last.answer;
  };
}

export async function handleHealthGet(probe: () => Promise<ServiceHealthDto>): Promise<Response> {
  const report: OrchestratorHealthReport = {
    status: "ok",
    service: "orchestrator",
    engine: await probe(),
  };
  // Never cached: a health answer from a minute ago is the one that hides an outage.
  return Response.json(report, { headers: { "cache-control": "no-store" } });
}
