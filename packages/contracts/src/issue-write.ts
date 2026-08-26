import { z } from "zod";
import { idSchema } from "./common.js";
import { issueFieldSchema } from "./integration-provider.js";

/**
 * Editing an imported Issue where it lives (spec F23 FR-13, Decision 0019).
 *
 * The rule this file exists to keep: **GateControl does not own any of these values.** An edit is
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
