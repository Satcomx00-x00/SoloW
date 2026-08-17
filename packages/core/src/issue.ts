import type { IssueStatus, TaskState } from "@gatecontrol/contracts";

/**
 * Derive an Issue's status from its Tasks (spec FR-006). Pure.
 * - In Progress while any Task is active.
 * - Resolved when there are Tasks and all are Done.
 * - Open when there are no Tasks (or none active and none done).
 * A manual override, when present, takes precedence and is applied by the caller.
 */
const ACTIVE: readonly TaskState[] = ["ready", "running", "review", "parked"];

export function deriveIssueStatus(taskStates: readonly TaskState[]): IssueStatus {
  if (taskStates.length === 0) return "open";
  if (taskStates.some((s) => ACTIVE.includes(s))) return "in_progress";
  if (taskStates.every((s) => s === "done")) return "resolved";
  return "open";
}
