import { z } from "zod";
import { idSchema, issueStatusSchema, timestampsSchema } from "./common.js";
import { pageInputSchema, pageOf } from "./page.js";
import { projectUserSchema } from "./project.js";
import { changeRequestStateSchema, issueSourceSchema } from "./scm.js";

/**
 * REVERSAL (issue #15-follow-up, 2026-08-20): this file used to say a native Issue-creation
 * form did not exist, "deliberately", per a 2026-08-19 product decision. User reports made the
 * decision unworkable in practice — importing is fine when the work already lives in a
 * connected tracker, but a user with no GitHub/GitLab integration at all (or one who wants to
 * jot down a Task's parent Issue before it exists upstream) had no way to use the board. So
 * `createIssueInput` is back.
 *
 * What survives from the reversed decision, because FR-3 still means it: an *imported* Issue's
 * `title`/`description` are the provider's own and SoloW still never edits them —
 * `updateIssueInput` refuses those two fields once `source !== "local"` (enforced in the DAL,
 * `apps/web/src/server/dal/issue.ts`). `labels` is the one field every Issue owns regardless of
 * source (it never belonged to FR-3's "canonical fields" list), so it stays editable always. A
 * locally created Issue reads `source: "local"` — the same value pre-#15 rows already carried —
 * rather than a new enum member, since "local" already means exactly "not imported".
 */

/** One label, trimmed. Mirrors `setupFilePatternSchema`'s bound style (packages/contracts/src/repository.ts). */
export const issueLabelSchema = z.string().trim().min(1).max(50);

/**
 * How many labels an Issue may carry. A generous ceiling on what is meant to be a handful of
 * short tags — a label list that needs more than this has stopped being a label list.
 */
export const MAX_ISSUE_LABELS = 20;

export const issueLabelsSchema = z.array(issueLabelSchema).max(MAX_ISSUE_LABELS);

/**
 * A pull or merge request the **provider itself** links to this Issue (spec F23 FR-8, issue #128).
 *
 * Read-only, for ever. SoloW does not open, review, approve or merge one from here — that
 * is issue #71's, behind the review gate — and a badge that could would be the first step towards
 * a second, worse client for the provider the team already has.
 *
 * Distinct from the branch a SoloW Task produced (issue #104). One is what the provider
 * knows, the other is what an agent did here; showing them as one list would make it impossible
 * to tell which of the two a reader is looking at.
 *
 * `state` reuses `changeRequestStateSchema` rather than declaring a second `open|closed|merged`:
 * two enums for one vocabulary is how the two drift apart.
 */
export const linkedChangeRequestSchema = z.object({
  /** The provider's own id — what makes a re-poll update a link rather than double it. */
  externalId: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: changeRequestStateSchema,
  url: z.string(),
  /** Non-null only for `merged`. Merge is the transition a poll is most likely to be late on. */
  mergedAt: z.string().nullable(),
});
export type LinkedChangeRequest = z.infer<typeof linkedChangeRequestSchema>;

/**
 * The milestone the provider has this Issue under, mirrored (spec F23 FR-8, user request
 * 2026-08-28). GitHub reports only a due date; GitLab reports both — `startDate` is simply null
 * on a provider that has none, the same "absent means the provider does not say" rule every
 * other optional mirror field here follows.
 */
export const issueMilestoneSchema = z.object({
  externalId: z.string(),
  title: z.string(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
});
export type IssueMilestone = z.infer<typeof issueMilestoneSchema>;

/**
 * The filters an Issue list can be narrowed by (spec F01 FR-2). Every one of them is optional
 * and they compose: the list is what survives all of them at once.
 *
 * `query` matches title, description or the provider's own issue number — "#42" and "42" both
 * find the imported Issue numbered 42, since that number is how a person refers to it out loud.
 * `labels` is an AND: an Issue must carry every label named, which is the only reading under
 * which adding a second label narrows rather than widens.
 *
 * There is no `priority` filter, though FR-2 lists one: an Issue has no priority in the domain
 * model, and F01's own "Out of scope" rules out custom fields. Adding it is a product decision,
 * not a gap in this list.
 */
export const listIssuesInput = z
  .object({
    status: issueStatusSchema.optional(),
    query: z.string().max(200).optional(),
    labels: issueLabelsSchema.optional(),
    source: issueSourceSchema.optional(),
    /** Narrows the Task-creation picker to the Issues that belong to one chosen Repository. */
    repositoryId: idSchema.optional(),
    /**
     * Only the Issues this Project holds — the rows of its `project_item` table.
     *
     * A Project is the top level of the interface (F23): every board, issue list and workflow is
     * read inside one. This is the filter that makes that true of the data and not merely of the
     * navigation, so a project-scoped screen cannot quietly show the whole Workspace.
     */
    projectId: idSchema.optional(),
    /**
     * Only the Issues that belong to **no** Project.
     *
     * The escape hatch, and deliberately not the default. An Issue imported before any Project
     * existed, or one from a repository no Project tracks, would otherwise have no screen at all
     * and would take its Tasks out of reach with it. Mutually exclusive with `projectId` in
     * practice: asking for both is asking for the empty set, and the DAL answers exactly that
     * rather than pretending one of them won.
     */
    unassigned: z.boolean().optional(),
  })
  .merge(pageInputSchema);
export type ListIssuesInput = z.infer<typeof listIssuesInput>;

export const getIssueInput = z.object({ id: idSchema });
export type GetIssueInput = z.infer<typeof getIssueInput>;

/** Every distinct label in use in the Workspace, so the list filter can offer a real vocabulary. */
export const issueLabelListDto = z.array(z.string());
export type IssueLabelListDto = z.infer<typeof issueLabelListDto>;

/**
 * The label vocabulary **with the provider's colours**, for every linked Repository at once.
 *
 * Separate from `issueLabelListDto` on purpose. That one is a cheap read of the names already
 * mirrored on each Issue; this one asks the providers, because a colour is not mirrored anywhere
 * — and a caller that only wants names should not pay for network calls to get them.
 *
 * `color` is null for a label whose provider reports none. Rendering it neutral is then the
 * honest answer: inventing a hue would tell the reader something the provider never said.
 */
export const issueLabelColorDto = z.object({
  name: z.string(),
  color: z.string().nullable(),
});
export const issueLabelColorListDto = z.array(issueLabelColorDto);
export type IssueLabelColorListDto = z.infer<typeof issueLabelColorListDto>;

/**
 * Set an Issue's status by hand (spec F01 FR-7), or hand it back to its Tasks with
 * `status: null` — an override is a claim about the work that the Tasks cannot make for
 * themselves ("this is resolved, whatever the board says"), and clearing it has to be as easy
 * as setting it or the derived status becomes unreachable.
 *
 * `force` is FR-9's deliberate close: closing an Issue with active Tasks under it is refused
 * with `IssueErrorCode.HasActiveTasks` unless the caller asks for it by name. It applies only
 * to `closed` — no other status leaves work stranded.
 */
export const setIssueStatusInput = z.object({
  id: idSchema,
  status: issueStatusSchema.nullable(),
  force: z.boolean().default(false),
});
export type SetIssueStatusInput = z.infer<typeof setIssueStatusInput>;

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
 * still marked active: deleting them here removes SoloW's record of those working trees,
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
    /** What the reader should believe: the override when one is set, the derived status otherwise. */
    status: issueStatusSchema,
    /**
     * What this Issue's Tasks say on their own. Sent alongside `status` rather than instead of
     * it so an override can be shown *as* an override — "Closed, though its tasks read In
     * progress" is the useful sentence, and it needs both halves.
     */
    derivedStatus: issueStatusSchema,
    statusOverride: issueStatusSchema.nullable(),
    /** When the override was set — null whenever `statusOverride` is (FR-7: recorded, not silent). */
    statusOverrideAt: z.string().nullable(),
    taskCount: z.number().int().nonnegative(),
    /** Tasks not yet finished (ready, running, review or parked) — what FR-9 refuses to close over. */
    activeTaskCount: z.number().int().nonnegative(),
    source: issueSourceSchema,
    /** Set together: the Repository it was imported into, and the provider's own issue number/URL. */
    repositoryId: idSchema.nullable(),
    externalNumber: z.number().int().nullable(),
    externalUrl: z.string().nullable(),
    /**
     * The provider's own id, and the id of the issue it hangs under.
     *
     * Carried so a *list* can draw the hierarchy the project table already draws. Without them an
     * issue list has no way to tell a sub-issue from a top-level one, and every child of an epic
     * appears beside its own parent as though it were a peer — which is what a reader then plans
     * from.
     *
     * The number is not a substitute: it is unique per repository, and a parent is named by id.
     */
    externalId: z.string().nullable(),
    externalParentId: z.string().nullable(),
    syncedAt: z.string().nullable(),
    labels: z.array(z.string()),
    /**
     * The provider's own links, mirrored (F23 FR-8). Empty means the provider reports none —
     * which the table renders as an empty cell rather than hiding the column, because "nothing
     * is in flight" is the answer a reviewer came for.
     */
    linkedChangeRequests: z.array(linkedChangeRequestSchema),
    /**
     * Who the provider has this Issue assigned to, mirrored (spec F23 FR-8, user request
     * 2026-08-28). Empty means the provider reports nobody — same "empty cell, not a hidden
     * column" rule `linkedChangeRequests` follows.
     */
    assignees: z.array(projectUserSchema),
    milestone: issueMilestoneSchema.nullable(),
  })
  .merge(timestampsSchema);
export type IssueDto = z.infer<typeof issueDto>;

/** A page of Issues — see `page.ts` for why every list procedure is one. */
export const issueListDto = pageOf(issueDto);
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
