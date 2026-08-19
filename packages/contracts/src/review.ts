import { z } from "zod";
import { idSchema, reviewDecisionSchema, timestampsSchema } from "./common.js";

export const reviewDecisionInput = z
  .object({
    sessionId: idSchema,
    decision: reviewDecisionSchema,
    /** Required when requesting changes; ignored otherwise. */
    feedback: z.string().max(10_000).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.decision === "request_changes" && !val.feedback?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["feedback"],
        message: "feedback is required when requesting changes",
      });
    }
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
