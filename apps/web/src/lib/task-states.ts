import type { TaskState } from "@solow/contracts";
import {
  CREDENTIAL_EXPIRED_REASON,
  INTERRUPTED_REASON,
  PARTIAL_INTEGRATION_REASON,
  STRANDED_REVIEW_REASON,
} from "@solow/core";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CirclePause,
  Eye,
  KeyRound,
  LoaderCircle,
  type LucideIcon,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";

export {
  CREDENTIAL_EXPIRED_REASON,
  INTERRUPTED_REASON,
  PARTIAL_INTEGRATION_REASON,
  STRANDED_REVIEW_REASON,
};

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
 * bare glyph in the navigator, a segment of the distribution bar, the wash over a column head —
 * and they must not drift.
 */
export interface StateStyle {
  icon: LucideIcon;
  /** Tinted fill, readable text and a hairline edge: the badge treatment. */
  badgeClassName: string;
  /** Just the foreground colour, for a bare glyph or a piece of text. */
  textClassName: string;
  /** Just the fill, for a chart segment or a rule. */
  barClassName: string;
  /** The fill at a whisper, for a surface that belongs to the state — a kanban column's head. */
  tintClassName: string;
  /** Longer-form meaning, used as the badge's accessible description. */
  hint: string;
}

export const STATE_STYLE: Record<TaskState, StateStyle> = {
  backlog: {
    icon: Circle,
    badgeClassName: "badge-soft [--badge-color:var(--state-idle)]",
    textClassName: "text-state-idle",
    barClassName: "bg-state-idle",
    tintClassName: "bg-state-idle/10",
    hint: "Not started",
  },
  ready: {
    icon: CircleDot,
    badgeClassName: "badge-soft [--badge-color:var(--state-queued)]",
    textClassName: "text-state-queued",
    barClassName: "bg-state-queued",
    tintClassName: "bg-state-queued/10",
    hint: "Queued, ready to launch",
  },
  running: {
    icon: LoaderCircle,
    badgeClassName: "badge-soft [--badge-color:var(--state-running)]",
    textClassName: "text-state-running",
    barClassName: "bg-state-running",
    tintClassName: "bg-state-running/10",
    hint: "A harness is working",
  },
  review: {
    icon: Eye,
    badgeClassName: "badge-soft [--badge-color:var(--state-review)]",
    textClassName: "text-state-review",
    barClassName: "bg-state-review",
    tintClassName: "bg-state-review/10",
    hint: "Waiting for your review",
  },
  parked: {
    icon: CirclePause,
    badgeClassName: "badge-soft [--badge-color:var(--state-parked)]",
    textClassName: "text-state-parked",
    barClassName: "bg-state-parked",
    tintClassName: "bg-state-parked/10",
    hint: "Paused on quota, resumes automatically",
  },
  failed: {
    icon: CircleAlert,
    badgeClassName: "badge-soft [--badge-color:var(--state-failed)]",
    textClassName: "text-state-failed",
    barClassName: "bg-state-failed",
    tintClassName: "bg-state-failed/10",
    hint: "The run failed, retry to try again",
  },
  done: {
    icon: CircleCheck,
    badgeClassName: "badge-soft [--badge-color:var(--state-done)]",
    textClassName: "text-state-done",
    barClassName: "bg-state-done",
    tintClassName: "bg-state-done/10",
    hint: "Approved and committed",
  },
};

/**
 * Every `failureReason` the product knows, as words an Owner can act on.
 *
 * One table for the card and the Task page both. The four reasons with a next step of their own
 * — a credential to renew, a restart to retry through, a review decision that never landed, a
 * half-committed Task — used to be drawn one by one on the card, and the page had nothing at
 * all; a second copy of that chain is how the two would have started disagreeing. Everything
 * else fell through to a badge that printed the raw class string in monospace — a machine name
 * shown to an Owner who cannot act on it, which is the same mistake `taskActionMessage` was
 * written to stop the banner making.
 *
 * `park_never_resumed` is not hypothetical: the orchestrator's sweep writes it onto a Task that
 * slept through its quota window, so the board really was rendering that string. Its literal is
 * repeated here rather than imported because it is defined in the orchestrator
 * (`apps/orchestrator/src/reconcile.ts`), which the web app does not depend on; `fail` and `park`
 * are `classifyRunFailure`'s own verdicts.
 *
 * The tone matters as much as the wording. A parked Task's reason painted in the failed red
 * would contradict the violet badge sitting next to it, so each reason names the state whose
 * colour and glyph it borrows — and the four with a glyph of their own say so, because the
 * glyph is what distinguishes "renew this" from "retry this" at a glance.
 */
const FAILURE_REASONS: Record<
  string,
  { label: string; tone: TaskState; icon?: LucideIcon; detail?: string }
> = {
  fail: { label: "Run failed", tone: "failed" },
  park: { label: "Paused on quota", tone: "parked" },
  park_never_resumed: { label: "Never resumed", tone: "parked" },
  // Distinguished from a generic failure (spec AC-013, issue #63): this one has a one-click fix.
  [CREDENTIAL_EXPIRED_REASON]: {
    label: "Credential expired",
    tone: "failed",
    icon: KeyRound,
    detail: "The harness's credential no longer works. Renew it, then retry.",
  },
  // The orchestrator restarted mid-run; the work is untouched and Retry picks it back up.
  [INTERRUPTED_REASON]: {
    label: "Interrupted by restart",
    tone: "failed",
    icon: RotateCcw,
    detail: "The orchestrator restarted mid-run. Nothing was lost; retry picks the run back up.",
  },
  // Not a failure of the work: the change is on its branch and the decision is in the record.
  [STRANDED_REVIEW_REASON]: {
    label: "Decision not applied",
    tone: "review",
    icon: TriangleAlert,
    detail:
      "The run holding this review gate was gone when the decision arrived. Retry re-runs it; nothing was lost.",
  },
  // The one failure where the work is *partly landed* (issue #70 AC-4).
  [PARTIAL_INTEGRATION_REASON]: {
    label: "Partly integrated",
    tone: "failed",
    icon: TriangleAlert,
    detail:
      "Some of this task's repositories were committed and others were not. The session log names which — the branches that landed are real.",
  },
};

export interface FailureReasonLabel {
  label: string;
  /** The state this reason borrows its colour from. */
  tone: TaskState;
  /** The reason's own glyph when it has one, otherwise the borrowed state's. */
  icon: LucideIcon;
  /** A sentence more, for a tooltip or a footer — null when the label says it all. */
  detail: string | null;
  /**
   * The raw class, and only when the label above is a generic stand-in for a reason this build
   * does not recognise. A class added upstream should still read as a failure to an Owner while
   * staying identifiable to whoever is debugging it.
   */
  code: string | null;
}

/** How a `failureReason` should read. */
export function failureReasonLabel(reason: string): FailureReasonLabel {
  const known = FAILURE_REASONS[reason];
  if (known) {
    return {
      label: known.label,
      tone: known.tone,
      icon: known.icon ?? STATE_STYLE[known.tone].icon,
      detail: known.detail ?? null,
      code: null,
    };
  }
  return {
    label: "Run failed",
    tone: "failed",
    icon: STATE_STYLE.failed.icon,
    detail: null,
    code: reason,
  };
}

/** The states that are actively moving, so the indicator spins only when work is happening. */
export const isLiveState = (state: TaskState): boolean => state === "running";

/** The one state that is waiting on a person. Drives the "needs you" emphasis on the board. */
export const needsAttention = (state: TaskState): boolean => state === "review";
