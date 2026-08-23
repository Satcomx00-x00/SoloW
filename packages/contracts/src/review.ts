import { z } from "zod";
import { idSchema, reviewDecisionSchema, timestampsSchema } from "./common.js";

/**
 * A human decision on a Session's diff.
 *
 * `feedback` used to be mandatory whenever the decision was `request_changes`, on the reasonable
 * theory that feedback is the whole mechanism: it is what the orchestrator forwards to the agent
 * as `pendingFeedback` on the next round, and without it the agent resumes on exactly the same
 * brief it already answered — so it will tend to produce the same work again, and the reviewer
 * will be back at the same gate. That reasoning still holds; what changed is that the Task page
 * no longer offers a feedback panel, and a rule the UI cannot satisfy is not a guardrail, it is a
 * button that never submits. So the requirement goes and the field stays: callers with something
 * to say — the API, MCP clients, any future UI that brings the panel back — still get it through
 * to the agent, and callers with nothing to say are no longer blocked from saying so.
 */
export const reviewDecisionInput = z.object({
  sessionId: idSchema,
  decision: reviewDecisionSchema,
  /** Forwarded to the agent on the next round when present; never required. */
  feedback: z.string().max(10_000).optional(),
});
export type ReviewDecisionInput = z.infer<typeof reviewDecisionInput>;

export const reviewDto = z
  .object({
    id: idSchema,
    sessionId: idSchema,
    decision: reviewDecisionSchema,
    feedback: z.string().nullable(),
    actorUserId: idSchema,
  })
  .merge(timestampsSchema);
export type ReviewDto = z.infer<typeof reviewDto>;
