import { type AuthMode, BillingErrorCode, err, type Result } from "@solow/contracts";
import {
  classifyRunFailure,
  type FailureSignal,
  resolveAgentRunEnv,
  withinConcurrencyCap,
} from "@solow/core";
import { decryptForAgentRun } from "@solow/db";

/**
 * Orchestrator-side billing/credential guard (Principle IV). Decrypts the credential and
 * shapes the agent process env; a subscription run can never carry the running agent's metered
 * credential variable — which variable that is comes from the Agent's catalog row (issue #10),
 * not a constant, so the guarantee holds for whichever agent is actually running.
 */
export function prepareAgentEnv(params: {
  authMode: AuthMode;
  secretCiphertext: string | null;
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** From the running Agent's `agent_catalog` row. */
  subscriptionEnvVar: string;
  meteredEnvVar: string;
  /** The Task's Executor Profile environment (issue #73); never able to reach the credential. */
  profileEnv?: Readonly<Record<string, string>>;
}): Result<Record<string, string>, typeof BillingErrorCode.MissingCredential> {
  if (!params.secretCiphertext) return err(BillingErrorCode.MissingCredential);
  const credentialValue = decryptForAgentRun(params.secretCiphertext);
  return resolveAgentRunEnv({
    authMode: params.authMode,
    credentialValue,
    baseEnv: params.baseEnv,
    subscriptionEnvVar: params.subscriptionEnvVar,
    meteredEnvVar: params.meteredEnvVar,
    ...(params.profileEnv ? { profileEnv: params.profileEnv } : {}),
  });
}

export function canStart(cap: number, running: number): boolean {
  return withinConcurrencyCap(cap, running);
}

export type { FailureSignal };
export { classifyRunFailure };
