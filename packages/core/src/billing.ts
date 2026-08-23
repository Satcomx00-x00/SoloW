import {
  type AuthMode,
  BillingErrorCode,
  err,
  isGuardedEnvVar,
  ok,
  type Result,
} from "@gatecontrol/contracts";

/**
 * Billing & credential shaping (constitution Principle IV — NON-NEGOTIABLE; spec F06).
 * Pure: takes an already-decrypted credential value and a base environment, returns the
 * environment for the agent process. The orchestrator decrypts and calls this.
 *
 * Billing integrity: a subscription-mode run MUST NOT be able to cause metered API
 * billing, so the agent's metered-credential variable is stripped from the returned
 * environment.
 *
 * Which two variables those are is a parameter, not a constant (issue #10): it used to be a
 * hardcoded `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` pair, which is Claude Code's own
 * naming and would have been silently wrong for the next agent's catalog row. Both names now
 * come from the running Agent Profile's `agent_catalog` row, so the guarantee holds for
 * whichever agent is actually running, not just the first one GateControl shipped.
 */

export interface ResolveEnvParams {
  authMode: AuthMode;
  /** Decrypted credential value: the OAuth token (subscription) or API key. */
  credentialValue: string | null;
  /** The base environment the agent process would otherwise inherit. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** From the running Agent's catalog row — see `agent-catalog.ts`. */
  subscriptionEnvVar: string;
  /** From the running Agent's catalog row — the variable that must never carry a value. */
  meteredEnvVar: string;
  /**
   * Extra environment from the Task's Executor Profile (issue #73). Applied *over* the base
   * environment and *under* the credential shaping below, so a profile can never set the
   * credential variables or preserve one the guard means to strip — AC-6 holds by ordering
   * rather than by review.
   *
   * The contract already refuses a profile that names a guarded variable, so a value reaching
   * here would have to predate that check or bypass the API. It is dropped anyway: this is the
   * last point at which billing integrity is still enforceable — and since the guarded names are
   * catalog-driven (issue #10), not just the Claude Code pair the contract's static check knows
   * about, this also strips `subscriptionEnvVar`/`meteredEnvVar` for whichever agent is actually
   * running, not only the two names the contract layer recognises.
   */
  profileEnv?: Readonly<Record<string, string>>;
}

export function resolveAgentRunEnv(
  params: ResolveEnvParams,
): Result<Record<string, string>, typeof BillingErrorCode.MissingCredential> {
  const { authMode, credentialValue, baseEnv, subscriptionEnvVar, meteredEnvVar, profileEnv } =
    params;
  if (!credentialValue) return err(BillingErrorCode.MissingCredential);

  // Copy the base env, dropping undefined values.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseEnv)) if (v !== undefined) env[k] = v;

  for (const [k, v] of Object.entries(profileEnv ?? {})) {
    if (isGuardedEnvVar(k) || k === subscriptionEnvVar || k === meteredEnvVar) continue;
    env[k] = v;
  }

  if (authMode === "subscription") {
    env[subscriptionEnvVar] = credentialValue;
    // Billing integrity: a metered credential in the env would divert to metered billing.
    delete env[meteredEnvVar];
  } else {
    env[meteredEnvVar] = credentialValue;
    // Avoid a stale subscription token silently taking precedence.
    delete env[subscriptionEnvVar];
  }
  return ok(env);
}

/** Enforce a per-Agent-Profile concurrency cap (spec FR-017). */
export function withinConcurrencyCap(cap: number, runningCount: number): boolean {
  return runningCount < cap;
}

export type FailureClass = "fail" | "park" | "credential_expired" | "interrupted";

/**
 * The `FailureClass` value a Task's `failureReason` holds when its Agent Profile's credential
 * was rejected or is missing (spec AC-013, issue #63).
 *
 * Exported as one constant rather than left as a string literal repeated at each of the three
 * places that write or read it (the orchestrator's failure classification, the DAL query that
 * finds Tasks to resume after a credential is replaced, the board card that renders them
 * distinctly) — a typo in any one of those would silently stop the credential-expiry path from
 * ever matching again, and nothing would fail loudly when it did.
 */
export const CREDENTIAL_EXPIRED_REASON: FailureClass = "credential_expired";

/**
 * The `failureReason` a Task carries when it was `running` with no agent process anywhere to
 * show for it — the orchestrator restarted (or crashed) mid-run and, unlike a review round's own
 * retry, nothing durable was left to redrive it (issue: reported directly by an Owner watching a
 * Task's input box answer "No agent is running" forever after a restart).
 *
 * `classifyRunFailure` never produces this value — it comes only from the orchestrator's own
 * boot-time reconciliation (`apps/orchestrator/src/reconcile.ts`), which is the one place with
 * standing to say "the process that was supposed to be running this is provably gone."
 */
export const INTERRUPTED_REASON: FailureClass = "interrupted";

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
