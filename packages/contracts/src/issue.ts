import { z } from "zod";
import { idSchema, issueStatusSchema, timestampsSchema } from "./common.js";

/** Inputs never carry workspaceId — it is derived from the session (Principle V). */
export const createIssueInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
});
export type CreateIssueInput = z.infer<typeof createIssueInput>;

export const listIssuesInput = z.object({
  status: issueStatusSchema.optional(),
  query: z.string().max(200).optional(),
});
export type ListIssuesInput = z.infer<typeof listIssuesInput>;

export const getIssueInput = z.object({ id: idSchema });
export type GetIssueInput = z.infer<typeof getIssueInput>;

export const issueDto = z
  .object({
    id: idSchema,
    title: z.string(),
    description: z.string().nullable(),
    status: issueStatusSchema,
    taskCount: z.number().int().nonnegative(),
  })
  .merge(timestampsSchema);
export type IssueDto = z.infer<typeof issueDto>;

export const issueListDto = z.array(issueDto);
export type IssueListDto = z.infer<typeof issueListDto>;
