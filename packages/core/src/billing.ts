import { type AuthMode, BillingErrorCode, err, ok, type Result } from "@gatecontrol/contracts";

/**
 * Billing & credential shaping (constitution Principle IV — NON-NEGOTIABLE; spec F06).
 * Pure: takes an already-decrypted credential value and a base environment, returns the
 * environment for the agent process. The orchestrator decrypts and calls this.
 *
 * Billing integrity: a subscription-mode run MUST NOT be able to cause metered API
 * billing, so `ANTHROPIC_API_KEY` is stripped from the returned environment.
 */

export interface ResolveEnvParams {
  authMode: AuthMode;
  /** Decrypted credential value: the OAuth token (subscription) or API key. */
  credentialValue: string | null;
  /** The base environment the agent process would otherwise inherit. */
  baseEnv: Readonly<Record<string, string | undefined>>;
}

export function resolveAgentRunEnv(
  params: ResolveEnvParams,
): Result<Record<string, string>, typeof BillingErrorCode.MissingCredential> {
  const { authMode, credentialValue, baseEnv } = params;
  if (!credentialValue) return err(BillingErrorCode.MissingCredential);

  // Copy the base env, dropping undefined values.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v;

  if (authMode === "subscription") {
    env["CLAUDE_CODE_OAUTH_TOKEN"] = credentialValue;
    // Billing integrity: an API key in the env would divert to metered billing.
    delete env["ANTHROPIC_API_KEY"];
  } else {
    env["ANTHROPIC_API_KEY"] = credentialValue;
    // Avoid a stale subscription token silently taking precedence.
    delete env["CLAUDE_CODE_OAUTH_TOKEN"];
  }
  return ok(env);
}

/** Enforce a per-Agent-Profile concurrency cap (spec FR-017). */
export function withinConcurrencyCap(cap: number, runningCount: number): boolean {
  return runningCount < cap;
}

export type FailureClass = "fail" | "park" | "credential_expired";

export interface FailureSignal {
  quotaExhausted?: boolean;
  credentialInvalid?: boolean;
}

/**
 * Classify a run failure into fail / park (quota) / credential-expired (spec FR-016,
 * AC-013). Quota exhaustion parks (recoverable); an invalid credential pauses distinctly;
 * anything else is a hard failure.
 */
export function classifyRunFailure(signal: FailureSignal): FailureClass {
  if (signal.quotaExhausted) return "park";
  if (signal.credentialInvalid) return "credential_expired";
  return "fail";
}

/**
 * Read a failure signal out of whatever the agent said as it died (its stderr, or the message
 * of the error that ended the run).
 *
 * The agent is an external CLI: it reports quota exhaustion and a rejected credential in prose,
 * not in a status code, so without this every failure would classify as a hard `fail` and a
 * Task that should merely park until the quota window resets would go to Failed instead
 * (spec AC-013). Matching is deliberately narrow — a false "park" would strand a Task for
 * hours, so anything unrecognised stays a plain failure.
 */
const QUOTA_PATTERNS = [
  /\bquota\b/i,
  /usage limit/i,
  /rate limit/i,
  /\b429\b/,
  /too many requests/i,
  /limit reached/i,
];
const CREDENTIAL_PATTERNS = [
  /\b401\b/,
  /\b403\b/,
  /unauthorized/i,
  /invalid[ _-]?api[ _-]?key/i,
  /authentication[ _-]?(failed|error)/i,
  /(oauth[ _-]?)?token (has )?expired/i,
  /credential.{0,20}(invalid|expired)/i,
];

export function detectFailureSignal(text: string | null | undefined): FailureSignal {
  if (!text) return {};
  const signal: FailureSignal = {};
  if (QUOTA_PATTERNS.some((p) => p.test(text))) signal.quotaExhausted = true;
  // Quota wins: a provider that returns 429 alongside a quota message has not rejected the
  // credential, and parking is the recoverable outcome.
  else if (CREDENTIAL_PATTERNS.some((p) => p.test(text))) signal.credentialInvalid = true;
  return signal;
}
