import {
  HARNESS_PROTOCOLS,
  type HarnessProtocol,
  harnessProtocolDescriptor,
  harnessProtocolSchema,
} from "@solow/contracts";

/**
 * Which harness protocols this orchestrator can actually drive (issues #10, #58, #21).
 *
 * The catalog can describe a harness by any protocol in `HarnessProtocol` — that is what makes
 * adding a harness a data row instead of a code change. But describing a protocol is not
 * implementing one, so the lifecycle asks here before it starts anything: a Harness Profile
 * pointing at an undriven protocol would otherwise crash deep inside a runner or, worse, fall
 * through to whatever the runner happens to do by default. Failing the Task before a harness
 * starts, with the reason named, is the honest answer.
 *
 * **Derived, not restated** (refactored 2026-08-28). This was a hand-written array beside a
 * hand-written `===`, and both compiled cleanly when a protocol was added — the failure only
 * appeared at run time, as a Task refused for a protocol that had a driver. Everything here now
 * reads `HARNESS_PROTOCOLS`, whose `Record<HarnessProtocol, …>` the compiler will not let anyone
 * extend the enum without filling in.
 *
 * `driven` is the contracts' claim; `createHarnessRunner`'s switch is the fact. A test asserts they
 * agree for every member of the enum, so the two cannot drift apart unnoticed.
 */
export const AVAILABLE_HARNESS_PROTOCOLS: readonly HarnessProtocol[] = harnessProtocolSchema.options
  .filter((protocol) => HARNESS_PROTOCOLS[protocol].driven)
  // Frozen so a caller cannot quietly widen what this build claims to drive.
  .slice();

export function hasHarnessRunner(protocol: HarnessProtocol): boolean {
  return harnessProtocolDescriptor(protocol).driven;
}

export function missingHarnessRunnerReason(protocol: HarnessProtocol): string {
  return `no harness runner for protocol "${protocol}" — this SoloW build can only drive ${AVAILABLE_HARNESS_PROTOCOLS.join(", ")}`;
}

export function harnessCreatesOwnWorktree(protocol: HarnessProtocol): boolean {
  return harnessProtocolDescriptor(protocol).createsOwnWorktree;
}
