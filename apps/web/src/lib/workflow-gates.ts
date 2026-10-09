import type { WorkflowAdvanceOn, WorkflowStepGate } from "@solow/contracts";

/**
 * A Step's review gate, said the same way on every screen that shows one (E3).
 *
 * The designer, its outline, the Task page's Step dialog and the board's Step columns each used
 * to carry their own words for the four gates — "A person approves it", "Waits for review",
 * "The AI decides on review", "Advances when you approve the review" — so a person met one setting
 * under four names. These are the names the designer's buttons show, and nothing else names a
 * gate. The stored values stay what they are: they are the API's, and a rename there is a
 * migration for no gain to anyone reading the screen.
 */
export const GATE_NAME: Record<WorkflowStepGate, string> = {
  human: "Wait for review",
  "agent-decides": "Harness decides",
  auto: "Move on",
  "auto-unless-changes": "Move on unless files changed",
};

/** What a gate means for the run, in one sentence for where there is room to say it. */
export const GATE_DESCRIPTION: Record<WorkflowStepGate, string> = {
  human: "The next step waits until you approve this one.",
  "agent-decides":
    "The harness says whether its work needs your review. If it does not say, the next step waits for you.",
  auto: "The next step starts as soon as this one is done.",
  "auto-unless-changes":
    "The next step starts as soon as this one is done, unless it changed files: then it waits for your review.",
};

/** The same, short enough for the line under the designer's buttons. */
export const GATE_HINT: Record<WorkflowStepGate, string> = {
  human: "The next step waits for your approval",
  "agent-decides": "The harness says if you need to look",
  auto: "Questions it asks still wait for you",
  "auto-unless-changes": "Questions it asks still wait for you",
};

/** The two signals a Step can count as finished on (`advanceOn`). */
export const FINISH_NAME: Record<WorkflowAdvanceOn, string> = {
  "agent-signal": "Harness says done",
  review: "You approve it",
};

/**
 * The gate a Step actually behaves as.
 *
 * A Step finished by a review (`advanceOn: "review"`) waits for one whatever its gate says: the
 * run ends at the review and only an approval starts the next Step. So "Move on" on such a Step
 * was a setting with no effect, and the designer showed it as chosen while the run still stopped.
 * Every screen reads this instead of the stored gate, so what it shows is what the run will do.
 */
export function effectiveGate(step: {
  gate: WorkflowStepGate;
  advanceOn: WorkflowAdvanceOn;
}): WorkflowStepGate {
  return step.advanceOn === "review" ? "human" : step.gate;
}
