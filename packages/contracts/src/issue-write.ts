import { z } from "zod";
import { idSchema } from "./common.js";
import { issueFieldSchema } from "./integration-provider.js";

/**
 * Editing an imported Issue where it lives (spec F23 FR-13, Decision 0019).
 *
 * The rule this file exists to keep: **SoloW does not own any of these values.** An edit is
 * sent to the provider and the answer is the provider's own reading of what it now holds — never
 * the value that was typed. Everything mirrored locally is refreshed from that answer, so the
 * mirror cannot drift into a second, quieter truth about the same issue.
 *
 * The local `issue.update` path keeps refusing to touch an imported Issue's title
 * (`IssueErrorCode.SourceOwned`) and that is not a contradiction: editing the *copy* is still
 * wrong. What changed is that there is now a way to edit the original.
 */

export const issueUserDto = z.object({
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type IssueUserDto = z.infer<typeof issueUserDto>;

export const issueMilestoneDto = z.object({
  externalId: z.string(),
  title: z.string(),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
});
export type IssueMilestoneDto = z.infer<typeof issueMilestoneDto>;

/**
 * One issue as the provider holds it right now, plus the vocabularies an editor needs.
 *
 * Read live rather than out of the mirror. A form built from the last poll shows a title someone
 * else changed an hour ago and saves over it without either party seeing a conflict; a form built
 * from the provider's current answer at least starts from the truth.
 */
/** One child of an epic, as much of it as a list in a panel needs. */
export const subIssueDto = z.object({
  issueId: idSchema,
  number: z.number().int().nullable(),
  title: z.string(),
  url: z.string().nullable(),
  /** Closed **on the provider** — never a Status column reading "Done" (F23 AC-2 / AC-3). */
  closed: z.boolean(),
});
export type SubIssueDto = z.infer<typeof subIssueDto>;

export const issueDetailDto = z.object({
  issueId: idSchema,
  externalNumber: z.number().int(),
  externalUrl: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  assignees: z.array(issueUserDto),
  labels: z.array(z.string()),
  milestone: issueMilestoneDto.nullable(),
  /** The provider's own label vocabulary for this repository — the picker's options. */
  availableLabels: z.array(z.object({ name: z.string(), color: z.string().nullable() })),
  availableAssignees: z.array(issueUserDto),
  availableMilestones: z.array(issueMilestoneDto),
  /**
   * The issues that name this one as their parent — what makes this panel an *epic's* panel.
   *
   * Resolved server-side rather than handed in by whichever surface opened the drawer: a panel
   * that only knew its children when opened from the project table would be a different panel
   * depending on where you came from, which is the kind of difference nobody remembers.
   *
   * Empty for an ordinary issue, and the panel then shows nothing rather than an empty heading.
   */
  subIssues: z.array(subIssueDto),
  /**
   * Which of these the provider will actually accept a change to, and the sentence to show where
   * a control would otherwise be (Decision 0016: ask for a capability, never for a provider).
   */
  writes: z.array(issueFieldSchema),
  cannot: z.record(issueFieldSchema, z.string()),
});
export type IssueDetailDto = z.infer<typeof issueDetailDto>;

export const issueDetailInput = z.object({ issueId: idSchema });
export type IssueDetailInput = z.infer<typeof issueDetailInput>;

/**
 * A patch. A key that is **absent is not being changed**.
 *
 * `.optional()` throughout rather than `.nullable()` with a default, because absent and null are
 * different instructions here — `milestone: null` clears it, no `milestone` key leaves it. An
 * editor that posted its whole form would silently overwrite every field it did not draw, which
 * is how a second client reverts a colleague's edit without either of them seeing it happen.
 */
export const updateExternalIssueInput = z.object({
  issueId: idSchema,
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(65_536).nullable().optional(),
  state: z.enum(["open", "closed"]).optional(),
  assignees: z.array(z.string()).max(50).optional(),
  labels: z.array(z.string()).max(100).optional(),
  milestone: z.string().nullable().optional(),
});
export type UpdateExternalIssueInput = z.infer<typeof updateExternalIssueInput>;

/**
 * One comment on an issue, as the drawer draws it.
 *
 * `body` is raw Markdown, rendered client-side — never HTML from the provider. A provider's HTML
 * would have to be trusted or sanitised, and the same renderer already draws the issue body two
 * inches above it.
 */
export const issueCommentDto = z.object({
  externalId: z.string(),
  author: issueUserDto.nullable(),
  body: z.string(),
  createdAt: z.string(),
  /** Set only when the comment was edited after posting — "edited" on every row is not a fact. */
  updatedAt: z.string().nullable(),
  url: z.string(),
});
export type IssueCommentDto = z.infer<typeof issueCommentDto>;

export const issueCommentListDto = z.object({
  comments: z.array(issueCommentDto),
  /**
   * Whether this build can post one.
   *
   * Read off the provider's declaration, so a read-only tracker shows the discussion with no
   * composer rather than a composer that fails on submit.
   */
  canComment: z.boolean(),
});
export type IssueCommentListDto = z.infer<typeof issueCommentListDto>;

export const createIssueCommentInput = z.object({
  issueId: idSchema,
  body: z.string().min(1).max(65_536),
});
export type CreateIssueCommentInput = z.infer<typeof createIssueCommentInput>;
