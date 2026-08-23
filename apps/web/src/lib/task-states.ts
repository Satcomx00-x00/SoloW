import type { TaskState } from "@gatecontrol/contracts";

export { CREDENTIAL_EXPIRED_REASON, INTERRUPTED_REASON } from "@gatecontrol/core";

import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  Eye,
  LoaderCircle,
  type LucideIcon,
} from "lucide-react";

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

/**
 * How each lifecycle state looks (task TASK-021 / F02).
 *
 * State is the one thing a reader opens this tool to learn, and the seven states are not equally
 * urgent: `review` is the only one waiting on a human (Principle I), `parked` resumes by itself
 * when the quota window resets, `failed` will not. Mapping them onto shadcn's four generic badge
 * variants collapsed three pairs into identical pills — Running read exactly like Review, Ready
 * like Done, Backlog like Parked — so the board said "seven columns" while the badges said
 * "four kinds of thing".
 *
 * Each state therefore carries its own hue *and* its own icon. Never colour alone: that would
 * fail WCAG 1.4.1 for a colour-blind reader, and these distinctions are the product.
 *
 * The parts are separate because the same state is drawn several ways — a pill on a card, a
 * bare glyph in the navigator, a segment of the distribution bar — and they must not drift.
 */
export interface StateStyle {
  icon: LucideIcon;
  /** Tinted fill, readable text and a hairline edge: the badge treatment. */
  badgeClassName: string;
  /** Just the foreground colour, for a bare glyph or a piece of text. */
  textClassName: string;
  /** Just the fill, for a chart segment or a rule. */
  barClassName: string;
  /** Longer-form meaning, used as the badge's accessible description. */
  hint: string;
}

export const STATE_STYLE: Record<TaskState, StateStyle> = {
  backlog: {
    icon: Circle,
    badgeClassName: "border-state-idle/25 bg-state-idle/10 text-state-idle",
    textClassName: "text-state-idle",
    barClassName: "bg-state-idle",
    hint: "Not started",
  },
  ready: {
    icon: CircleDot,
    badgeClassName: "border-state-queued/30 bg-state-queued/10 text-state-queued",
    textClassName: "text-state-queued",
    barClassName: "bg-state-queued",
    hint: "Queued, ready to launch",
  },
  running: {
    icon: LoaderCircle,
    badgeClassName: "border-state-running/35 bg-state-running/12 text-state-running",
    textClassName: "text-state-running",
    barClassName: "bg-state-running",
    hint: "An agent is working",
  },
  review: {
    icon: Eye,
    badgeClassName: "border-state-review/45 bg-state-review/15 text-state-review",
    textClassName: "text-state-review",
    barClassName: "bg-state-review",
    hint: "Waiting for your review",
  },
  parked: {
    icon: CirclePause,
    badgeClassName: "border-state-parked/30 bg-state-parked/12 text-state-parked",
    textClassName: "text-state-parked",
    barClassName: "bg-state-parked",
    hint: "Paused on quota, resumes automatically",
  },
  failed: {
    icon: CircleAlert,
    badgeClassName: "border-state-failed/40 bg-state-failed/12 text-state-failed",
    textClassName: "text-state-failed",
    barClassName: "bg-state-failed",
    hint: "The run failed, retry to try again",
  },
  done: {
    icon: CircleCheck,
    badgeClassName: "border-state-done/30 bg-state-done/12 text-state-done",
    textClassName: "text-state-done",
    barClassName: "bg-state-done",
    hint: "Approved and committed",
  },
};

/** The states that are actively moving, so the indicator spins only when work is happening. */
export const isLiveState = (state: TaskState): boolean => state === "running";

/** The one state that is waiting on a person. Drives the "needs you" emphasis on the board. */
export const needsAttention = (state: TaskState): boolean => state === "review";
