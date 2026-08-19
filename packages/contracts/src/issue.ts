import { z } from "zod";
import { idSchema, issueStatusSchema, timestampsSchema } from "./common.js";
import { issueSourceSchema } from "./scm.js";

/**
 * Issues are no longer created by hand (issue #10-adjacent product decision, 2026-08-19): every
 * Issue in GateControl comes from importing a real GitHub or GitLab issue (`scm.importIssues`,
 * see `scm.ts`) — there is deliberately no `createIssueInput` here any more. The one exception
 * is data that predates this feature, which reads with `source: "local"`.
 */

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
    source: issueSourceSchema,
    /** Set together: the Repository it was imported into, and the provider's own issue number/URL. */
    repositoryId: idSchema.nullable(),
    externalNumber: z.number().int().nullable(),
    externalUrl: z.string().nullable(),
    syncedAt: z.string().nullable(),
  })
  .merge(timestampsSchema);
export type IssueDto = z.infer<typeof issueDto>;

export const issueListDto = z.array(issueDto);
export type IssueListDto = z.infer<typeof issueListDto>;
