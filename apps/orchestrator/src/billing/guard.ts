import { type AuthMode, BillingErrorCode, err, type Result } from "@gatecontrol/contracts";
import {
  classifyRunFailure,
  type FailureSignal,
  resolveAgentRunEnv,
  withinConcurrencyCap,
} from "@gatecontrol/core";
import { decryptForAgentRun } from "@gatecontrol/db";

/**
 * Orchestrator-side billing/credential guard (Principle IV). Decrypts the credential and
 * shapes the agent process env; a subscription run can never carry ANTHROPIC_API_KEY.
 */
export function prepareAgentEnv(params: {
  authMode: AuthMode;
  secretCiphertext: string | null;
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** The Task's Executor Profile environment (issue #73); never able to reach the credential. */
  profileEnv?: Readonly<Record<string, string>>;
}): Result<Record<string, string>, typeof BillingErrorCode.MissingCredential> {
  if (!params.secretCiphertext) return err(BillingErrorCode.MissingCredential);
  const credentialValue = decryptForAgentRun(params.secretCiphertext);
  return resolveAgentRunEnv({
    authMode: params.authMode,
    credentialValue,
    baseEnv: params.baseEnv,
    ...(params.profileEnv ? { profileEnv: params.profileEnv } : {}),
  });
}

export function canStart(cap: number, running: number): boolean {
  return withinConcurrencyCap(cap, running);
}

export type { FailureSignal };
export { classifyRunFailure };
