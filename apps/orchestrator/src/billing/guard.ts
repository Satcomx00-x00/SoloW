import {
  type AuthMode,
  type Result,
  BillingErrorCode,
  err,
} from "@gatecontrol/contracts";
import {
  type FailureSignal,
  classifyRunFailure,
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
}): Result<Record<string, string>, typeof BillingErrorCode.MissingCredential> {
  if (!params.secretCiphertext) return err(BillingErrorCode.MissingCredential);
  const credentialValue = decryptForAgentRun(params.secretCiphertext);
  return resolveAgentRunEnv({
    authMode: params.authMode,
    credentialValue,
    baseEnv: params.baseEnv,
  });
}

export function canStart(cap: number, running: number): boolean {
  return withinConcurrencyCap(cap, running);
}

export { classifyRunFailure };
export type { FailureSignal };
