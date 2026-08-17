import type { TaskState } from "@gatecontrol/contracts";

/**
 * Board column order + display labels for the Task lifecycle (spec Domain Model / F02).
 * Centralized so labels are translatable in one place (full i18n is a follow-up).
 */
export const BOARD_COLUMNS: readonly TaskState[] = [
  "backlog",
  "ready",
  "running",
  "review",
  "parked",
  "failed",
  "done",
];

export const STATE_LABELS: Record<TaskState, string> = {
  backlog: "Backlog",
  ready: "Ready",
  running: "Running",
  review: "Review",
  parked: "Parked",
  failed: "Failed",
  done: "Done",
};

/** Badge variant per lifecycle state (shadcn Badge variants). */
export const STATE_BADGE: Record<TaskState, "default" | "secondary" | "destructive" | "outline"> = {
  backlog: "outline",
  ready: "secondary",
  running: "default",
  review: "default",
  parked: "outline",
  failed: "destructive",
  done: "secondary",
};
