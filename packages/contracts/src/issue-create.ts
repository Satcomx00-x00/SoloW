import { z } from "zod";
import { idSchema } from "./common.js";
import { issueLinkTypeSchema } from "./integration-provider.js";
import { issueLabelsSchema } from "./issue.js";

/**
 * Creating a brand-new Issue or Epic **on the provider**, from inside a Project (spec F23a
 * Part 1).
 *
 * The opposite direction from `issue-write.ts`'s edit path, and its sibling: that file exists
 * because SoloW does not own an imported Issue's fields once it exists, and this one exists
 * because SoloW does not originate one either — a title and a body are sent out, and what
 * comes back mirrored in is the provider's own answer, never the value that was typed (the same
 * F23 NFR-7 rule `issue-write.ts`'s own doc comment states). `createIssueInput` in `issue.ts` is
 * a different feature entirely: it creates a **local** Issue that has never touched a provider
 * and never will. This file is for the case where the whole point is that it does.
 *
 * There is no local equivalent of an Epic at all — it is a GitLab group object with no domain
 * concept SoloW invents on its own, so unlike the Issue side there is nothing here to distinguish
 * this create path from.
 */

export const createProviderIssueInput = z.object({
  /**
   * Where the issue is created — resolved by the DAL to the Repository's `(provider, RepoRef)`,
   * the same way `listRepositoryLabelsInput` resolves a label picker.
   */
  repositoryId: idSchema,
  /**
   * The Project row to attach the mirrored Issue to once it exists. Optional: a Repository can
   * be worked on outside any Project, and creating an Issue on one is still a coherent action —
   * it simply is not offered its own row in a table until it is attached to one.
   */
  projectId: idSchema.optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(65_536).optional(),
  /** Provider logins — the driver resolves these to whatever the provider assigns by internally. */
  assignees: z.array(z.string()).max(50).optional(),
  labels: issueLabelsSchema.optional(),
  /** The provider's own milestone id — the value `IssueMilestoneDto.externalId` carries. */
  milestone: z.string().optional(),
  /**
   * The epic this Issue is created under — meaningful on GitLab only. A GitHub caller simply
   * never sends it, the "ask the manifest, never the provider's name" rule (Decision 0016) that
   * keeps this schema from branching on which provider the Repository happens to be on.
   */
  parentEpicId: z.string().optional(),
  /**
   * The five fields below are each gated by a flag on the provider's `issueCreates` manifest
   * (`IssueCreateSupport`) — the same "ask the manifest, never the provider's name" rule
   * `parentEpicId` follows just above. A GitHub caller simply never sends any of them.
   */
  /** ISO `YYYY-MM-DD`. A due date only: a GitLab issue has no start date (Decision 0018). */
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date, YYYY-MM-DD.")
    .optional(),
  /** A non-negative whole number — GitLab's issue weight. */
  weight: z.number().int().min(0).max(10_000).optional(),
  /** Create the Issue visible only to members. */
  confidential: z.boolean().optional(),
  /**
   * An up-front estimate in the provider's own duration grammar (`"2h"`, `"3d 4h"`). Validated
   * only for shape here — which durations are legal is the provider's own answer, and it gives a
   * better message for a bad one than a regex in this file could.
   */
  timeEstimate: z
    .string()
    .max(40)
    .regex(/^(\d+(\.\d+)?(mo|w|d|h|m)\s*)+$/, "Use a duration like 2h, 3d or 1w 2d.")
    .optional(),
  /** Existing Issues to link the new one to, by their number within the same repository. */
  links: z
    .array(z.object({ issueNumber: z.number().int().positive(), type: issueLinkTypeSchema }))
    .max(20)
    .optional(),
  /**
   * The three below are the provider's extras on the other side — GitHub's — and they are gated
   * the same way, by `issueCreates.issueTypes` / `.parentIssue` / `.providerProject`. A GitLab
   * caller simply never sends any of them, exactly as a GitHub caller never sends the five above.
   */
  /**
   * The provider's own name for an issue type ("Bug", "Feature", "Task"). The *name*, not an id:
   * that is what GitHub's create endpoint takes, and the picker is populated from the same list
   * the provider answers with, so there is no id here to be stale.
   */
  issueType: z.string().max(80).optional(),
  /**
   * The Issue this one is created under, by its number within the same repository — GitHub's
   * sub-issues. A number rather than an id for the same reason `links` uses one: it is what a
   * person reading the repository sees, and it is the space the picker offers.
   */
  parentIssueNumber: z.number().int().positive().optional(),
  /**
   * A provider project board to put the new Issue on — the same opaque id `project.listAvailable`
   * reports as `externalId` and the `project` row stores as `providerProjectId`.
   */
  providerProjectId: z.string().max(200).optional(),
});
export type CreateProviderIssueInput = z.infer<typeof createProviderIssueInput>;

/**
 * What creating a provider Issue answers with — enough for the caller to select and scroll to
 * the new row (spec F23a Flow A, Action 5), not the row's full shape. The mirrored Issue is read
 * back through the ordinary Issue list/detail procedures like any other; duplicating `issueDto`
 * here would be a second copy of a shape that already exists.
 */
export const createdProviderIssueDto = z.object({
  issueId: idSchema,
  externalNumber: z.number().int(),
  externalUrl: z.string(),
  title: z.string(),
});
export type CreatedProviderIssueDto = z.infer<typeof createdProviderIssueDto>;

/**
 * A GitLab group the connected token can create an epic in — what makes the epic "Where" modal's
 * picker a pick rather than a typed guess, the same reason `ExternalRepository`/its DTO exist for
 * repositories. `integrationId` names which connection it came from, the same way
 * `availableProjectDto` (`project.ts`) carries it for an unadopted provider project — a group
 * picker has to work before any SoloW Project exists to hang the question off of.
 */
export const externalGroupDto = z.object({
  integrationId: idSchema,
  externalId: z.string(),
  fullPath: z.string(),
  name: z.string(),
  url: z.string(),
});
export type ExternalGroupDto = z.infer<typeof externalGroupDto>;

export const listGroupsInput = z.object({ integrationId: idSchema });
export type ListGroupsInput = z.infer<typeof listGroupsInput>;

/**
 * A GitLab epic, mirrored just enough for a "parent epic" picker and for the row the create flow
 * inserts (spec F23a Flow B). The neutral domain calls this "a parent planning item"
 * (`ExternalIssue.parentExternalId` is where a caller elsewhere sees that neutral shape); this
 * DTO stays named for what it concretely is, because the epic "Where"/"Compose epic" modals are
 * the one surface that is unapologetically GitLab-specific — Decision 0016 asks that a capability
 * difference be stated, not that its shape be laundered into something it is not.
 */
export const externalEpicDto = z.object({
  externalId: z.string(),
  /** The epic's number within its group — the same iid/number distinction `issueDto` draws. */
  iid: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed"]),
  startDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  /** The group it lives in — the same value `listEpics`/`createEpic` take as `groupRef`. */
  groupRef: z.string(),
});
export type ExternalEpicDto = z.infer<typeof externalEpicDto>;

export const listEpicsInput = z.object({
  integrationId: idSchema,
  groupRef: z.string().min(1),
});
export type ListEpicsInput = z.infer<typeof listEpicsInput>;

export const createEpicInput = z.object({
  integrationId: idSchema,
  groupRef: z.string().min(1),
  /** The Project row to attach the mirrored Epic row to — see `createProviderIssueInput.projectId`. */
  projectId: idSchema.optional(),
  title: z.string().min(1).max(300),
  description: z.string().max(65_536).optional(),
  labels: issueLabelsSchema.optional(),
  /**
   * `undefined` leaves GitLab's default (an epic's dates computed from its milestones);
   * `null` clears a fixed date; a string fixes it — the same three-state rule `EpicSeed` in
   * `@solow/scm` follows, carried through to this input rather than collapsed to `.optional()`
   * alone, which would make "leave alone" and "clear" the same request.
   */
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
});
export type CreateEpicInput = z.infer<typeof createEpicInput>;

/** What creating an Epic answers with — the mirrored row, same shape `externalEpicDto` lists in. */
export const createdEpicDto = externalEpicDto;
export type CreatedEpicDto = ExternalEpicDto;
