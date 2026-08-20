import { z } from "zod";
import { idSchema, issueStatusSchema, timestampsSchema } from "./common.js";
import { issueSourceSchema } from "./scm.js";

/**
 * REVERSAL (issue #15-follow-up, 2026-08-20): this file used to say a native Issue-creation
 * form did not exist, "deliberately", per a 2026-08-19 product decision. User reports made the
 * decision unworkable in practice — importing is fine when the work already lives in a
 * connected tracker, but a user with no GitHub/GitLab integration at all (or one who wants to
 * jot down a Task's parent Issue before it exists upstream) had no way to use the board. So
 * `createIssueInput` is back.
 *
 * What survives from the reversed decision, because FR-3 still means it: an *imported* Issue's
 * `title`/`description` are the provider's own and GateControl still never edits them —
 * `updateIssueInput` refuses those two fields once `source !== "local"` (enforced in the DAL,
 * `apps/web/src/server/dal/issue.ts`). `labels` is the one field every Issue owns regardless of
 * source (it never belonged to FR-3's "canonical fields" list), so it stays editable always. A
 * locally created Issue reads `source: "local"` — the same value pre-#15 rows already carried —
 * rather than a new enum member, since "local" already means exactly "not imported".
 */

export const listIssuesInput = z.object({
  status: issueStatusSchema.optional(),
  query: z.string().max(200).optional(),
  /** Narrows the Task-creation picker to the Issues that belong to one chosen Repository. */
  repositoryId: idSchema.optional(),
});
export type ListIssuesInput = z.infer<typeof listIssuesInput>;

export const getIssueInput = z.object({ id: idSchema });
export type GetIssueInput = z.infer<typeof getIssueInput>;

/** One label, trimmed. Mirrors `setupFilePatternSchema`'s bound style (packages/contracts/src/repository.ts). */
export const issueLabelSchema = z.string().trim().min(1).max(50);

/**
 * How many labels an Issue may carry. A generous ceiling on what is meant to be a handful of
 * short tags — a label list that needs more than this has stopped being a label list.
 */
export const MAX_ISSUE_LABELS = 20;

export const issueLabelsSchema = z.array(issueLabelSchema).max(MAX_ISSUE_LABELS);

/**
 * Create a local Issue. `repositoryId` is required — not optional the way it is nullable on the
 * row — so every new Issue, local or imported, can be found by the Task-creation picker's
 * repository filter (`listIssuesInput.repositoryId`); a repository-less Issue would be a dead
 * end there.
 */
export const createIssueInput = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  repositoryId: idSchema,
  labels: issueLabelsSchema.default([]),
});
export type CreateIssueInput = z.infer<typeof createIssueInput>;

/**
 * Edit an Issue. No `repositoryId` — an Issue's repository is fixed at creation, the same way a
 * Task's is. `title`/`description` are accepted here (the DAL is what refuses them for a
 * non-local Issue, since the source is a DB read, not something this input carries) so the
 * schema stays one shape for both the local and imported case; only the label list is guaranteed
 * to always apply.
 */
export const updateIssueInput = z.object({
  id: idSchema,
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(20_000).optional(),
  labels: issueLabelsSchema.optional(),
});
export type UpdateIssueInput = z.infer<typeof updateIssueInput>;

/**
 * Delete an Issue. `force` is what turns the has-Tasks refusal into a cascade: without it the
 * DAL refuses while Tasks exist (spec F01 States & Rules), with it the Issue and everything
 * hanging off its Tasks goes. Defaulted rather than required so every existing caller keeps the
 * safe behaviour, and so the destructive path is only ever reached by asking for it by name.
 */
export const deleteIssueInput = z.object({ id: idSchema, force: z.boolean().default(false) });
export type DeleteIssueInput = z.infer<typeof deleteIssueInput>;

export const issueDeletionImpactInput = z.object({ id: idSchema });
export type IssueDeletionImpactInput = z.infer<typeof issueDeletionImpactInput>;

/**
 * What a force delete would actually destroy — read by the confirmation dialog so the count it
 * states is the real one rather than a guess. `worktreeCount` is the number of `worktree` rows
 * still marked active: deleting them here removes GateControl's record of those working trees,
 * but not the directories themselves (removing those lives in the orchestrator, on the far side
 * of the Executor boundary), so the dialog warns rather than promises.
 */
export const issueDeletionImpactDto = z.object({
  taskCount: z.number().int().nonnegative(),
  /** Tasks that must be stopped before the cascade can run. */
  runningTaskCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  worktreeCount: z.number().int().nonnegative(),
});
export type IssueDeletionImpactDto = z.infer<typeof issueDeletionImpactDto>;

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
    labels: z.array(z.string()),
  })
  .merge(timestampsSchema);
export type IssueDto = z.infer<typeof issueDto>;

export const issueListDto = z.array(issueDto);
export type IssueListDto = z.infer<typeof issueListDto>;

/**
 * A repository label, for the Issue label picker. Lives here rather than in
 * `packages/contracts/src/repository.ts` because it exists only to serve that picker, and
 * `issue.ts` is the one contracts file this track owns — a genuinely repository-shaped type
 * would belong in `repository.ts` instead.
 */
export const repositoryLabelDto = z.object({
  name: z.string(),
  /** Normalized to `#RRGGBB` by the driver (GitHub returns it unprefixed; GitLab already is). */
  color: z.string().nullable(),
  description: z.string().nullable(),
});
export type RepositoryLabelDto = z.infer<typeof repositoryLabelDto>;

export const listRepositoryLabelsInput = z.object({
  repositoryId: idSchema,
});
export type ListRepositoryLabelsInput = z.infer<typeof listRepositoryLabelsInput>;
