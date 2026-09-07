import { type AuthMode, BillingErrorCode, err, type Result } from "@solow/contracts";
import {
  classifyRunFailure,
  type FailureSignal,
  resolveHarnessRunEnv,
  withinConcurrencyCap,
} from "@solow/core";
import { decryptForHarnessRun } from "@solow/db";

/**
 * Orchestrator-side billing/credential guard (Principle IV). Decrypts the credential and
 * shapes the harness process env; a subscription run can never carry the running harness's metered
 * credential variable — which variable that is comes from the Harness's catalog row (issue #10),
 * not a constant, so the guarantee holds for whichever harness is actually running.
 */
export function prepareHarnessEnv(params: {
  authMode: AuthMode;
  secretCiphertext: string | null;
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** From the running Harness's `agent_catalog` row. */
  subscriptionEnvVar: string;
  meteredEnvVar: string;
  /** The Task's Executor Profile environment (issue #73); never able to reach the credential. */
  profileEnv?: Readonly<Record<string, string>>;
}): Result<Record<string, string>, typeof BillingErrorCode.MissingCredential> {
  if (!params.secretCiphertext) return err(BillingErrorCode.MissingCredential);
  const credentialValue = decryptForHarnessRun(params.secretCiphertext);
  return resolveHarnessRunEnv({
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
