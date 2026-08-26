import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

/**
 * Project planning contracts (spec F23, Decision 0018).
 *
 * The provider owns these values and GateControl mirrors them. That is the one thing to keep in
 * mind reading this file: nothing here is authoritative, every shape is a cache of something a
 * provider said, and a disagreement is resolved by asking the provider again.
 */

/**
 * The field types a project can hold — a closed union, translated at the driver.
 *
 * Closed because the table has to *render* a field, and a renderer needs a kind rather than
 * whatever string the provider chose to call it. A provider type with no member here is not
 * dropped: the field arrives read-only, named as the provider names it, which is how a column
 * set stays honest about what the project actually holds (F23, States & rules).
 */
export const projectFieldTypeSchema = z.enum([
  "text",
  "number",
  "date",
  "single_select",
  "iteration",
  "user",
  "url",
]);
export type ProjectFieldType = z.infer<typeof projectFieldTypeSchema>;

/** Every field type, for a provider declaring it can express all of them. */
export const PROJECT_FIELD_TYPES = projectFieldTypeSchema.options;

/** One choice of a single-select, as the provider names and colours it. */
export const projectFieldOptionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** The provider's own colour name or hex, rendered as-is. Absent where it offers none. */
  color: z.string().optional(),
});
export type ProjectFieldOption = z.infer<typeof projectFieldOptionSchema>;

/** One iteration — a named date range, which is all every provider agrees an iteration is. */
export const projectIterationSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  startDate: z.string(),
  /** Inclusive end. Providers disagree on duration-vs-end; the driver normalises to an end. */
  endDate: z.string(),
});
export type ProjectIteration = z.infer<typeof projectIterationSchema>;

/** A person, as much of one as a planning table needs. */
export const projectUserSchema = z.object({
  login: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});
export type ProjectUser = z.infer<typeof projectUserSchema>;

/**
 * A field's value, discriminated by the type of the field holding it.
 *
 * The discriminant is carried rather than inferred from context so a value can be passed around
 * on its own — a cell renderer receives a value and knows what it is, without also being handed
 * the field it came from.
 */
export const projectFieldValueSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("number"), number: z.number() }),
  z.object({ type: z.literal("date"), date: z.string() }),
  z.object({ type: z.literal("single_select"), optionId: z.string() }),
  z.object({ type: z.literal("iteration"), iterationId: z.string() }),
  z.object({ type: z.literal("user"), users: z.array(projectUserSchema) }),
  z.object({ type: z.literal("url"), url: z.string() }),
]);
export type ProjectFieldValue = z.infer<typeof projectFieldValueSchema>;

/**
 * Read a stored value back as the type its field says it is (F23, #121 AC-3).
 *
 * Null for anything that does not parse, and the caller renders an empty cell. That is the whole
 * contract: a value written by an older build, or by a provider that changed a field's type under
 * us, costs one blank cell — never a row that fails to render, and never a crash inside a
 * virtualized grid where one bad row would take the viewport with it.
 *
 * The field's type is the authority, not the value's own `type` tag: a value tagged `number`
 * sitting in a field that is now `text` is a value in the wrong shape, and trusting its tag would
 * hand the text renderer a number.
 */
export function parseProjectFieldValue(
  type: ProjectFieldType,
  raw: unknown,
): ProjectFieldValue | null {
  if (raw === null || raw === undefined) return null;
  const parsed = projectFieldValueSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.type === type ? parsed.data : null;
}

export const projectFieldDto = z.object({
  id: idSchema,
  /** The provider's id for this field. The name is a label; this is the key. */
  providerFieldId: z.string(),
  name: z.string(),
  type: projectFieldTypeSchema,
  /** Options for a single-select, iterations for an iteration field, empty otherwise. */
  options: z.array(projectFieldOptionSchema),
  iterations: z.array(projectIterationSchema),
  position: z.number().int().nonnegative(),
  /**
   * Whether this provider can hold a value for this field, and why not when it cannot.
   *
   * The provider's answer, recorded at sync so the table never has to ask (Decision 0018). The
   * reason is shown to the operator verbatim — "GitLab weights need a paid tier" is a sentence a
   * person can act on, where a disabled input with no explanation is not.
   */
  readOnly: z.boolean(),
  readOnlyReason: z.string().nullable(),
});
export type ProjectFieldDto = z.infer<typeof projectFieldDto>;

export const projectItemDto = z.object({
  id: idSchema,
  providerItemId: z.string(),
  /** The Issue this row projects. Everything GateControl owns hangs off it. */
  issueId: idSchema,
  position: z.number().int().nonnegative(),
  archivedAt: z.string().nullable(),
  /** Field values by `projectFieldDto.id`, already parsed against their field's type. */
  values: z.record(z.string(), projectFieldValueSchema),
  /**
   * The hierarchy the table nests by, carried on the row (spec F23 FR-7, issue #127).
   *
   * Read off the Issue rather than stored on the item, because the parent is the provider's fact
   * about an issue and not about its membership of one project — the same issue in two projects
   * has the same parent in both.
   *
   * These are the **provider's** ids: resolving one to a row is a question about the rows that are
   * actually in the project, which only the table can answer (`buildProjectHierarchy`). Null
   * `issueExternalId` is a row whose Issue has no provider behind it, and it simply never matches.
   */
  issueExternalId: z.string().nullable(),
  parentExternalId: z.string().nullable(),
  /** The Repository the Issue came from — the tie-break where a provider's ids restart per repo. */
  repositoryId: idSchema.nullable(),
  /**
   * Closed on the provider (#127 AC-3).
   *
   * The one thing an epic's progress may be counted from. Not a Status field reading "Done": that
   * is a team's convention, and a convention is not a completion. False for an Issue whose state
   * the mirror has never been told, because a guess would move a percentage nobody changed.
   */
  closed: z.boolean(),
});
export type ProjectItemDto = z.infer<typeof projectItemDto>;

export const projectDto = z
  .object({
    id: idSchema,
    integrationId: idSchema,
    providerProjectId: z.string(),
    title: z.string(),
    /** When the mirror last agreed with the provider. Null before the first sync completes. */
    syncedAt: z.string().nullable(),
    /**
     * How many rows this Project holds.
     *
     * Carried on the DTO because the Projects hub exists to answer "which project has the work",
     * and it cannot answer that from `fields` — the list read deliberately does not load a
     * Project's fields (one query per Project), so `fields: []` there means *not loaded*, not
     * *none*. A hub that counted them printed "0 fields" over a project with nineteen.
     */
    itemCount: z.number().int().nonnegative(),
    fields: z.array(projectFieldDto),
  })
  .merge(timestampsSchema);
export type ProjectDto = z.infer<typeof projectDto>;

export const listProjectItemsInput = z.object({
  projectId: idSchema,
  /** Paged, because a project is large on day one (F23 NFR-1). */
  limit: z.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});
export type ListProjectItemsInput = z.infer<typeof listProjectItemsInput>;

export const projectItemPageDto = z.object({
  items: z.array(projectItemDto),
  /** Null when the last page has been read. */
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
export type ProjectItemPageDto = z.infer<typeof projectItemPageDto>;

/** A project the Workspace's tokens can see but does not yet mirror. */
export const availableProjectDto = z.object({
  integrationId: idSchema,
  provider: z.string(),
  externalId: z.string(),
  title: z.string(),
  url: z.string(),
  /** The user or organization it belongs to. Two orgs with a "Roadmap" are otherwise the same row. */
  ownerLogin: z.string().nullable(),
  /** Already mirrored — shown in the picker, and not offered twice. */
  adopted: z.boolean(),
});
export type AvailableProjectDto = z.infer<typeof availableProjectDto>;

export const adoptProjectInput = z.object({
  integrationId: idSchema,
  providerProjectId: z.string().min(1),
  title: z.string().min(1).max(200),
});
export type AdoptProjectInput = z.infer<typeof adoptProjectInput>;

export const projectIdInput = z.object({ projectId: idSchema });
export type ProjectIdInput = z.infer<typeof projectIdInput>;

/** What one refresh pass moved, so the UI can say "24 rows, 3 waiting on their issues". */
export const projectRefreshDto = z.object({
  items: z.number().int().nonnegative(),
  /** Rows whose Issue has not been ingested yet — they arrive on a later pass, not never. */
  skipped: z.number().int().nonnegative(),
  /** Rows the provider has that this table will not: every row here is an Issue (F23). */
  drafts: z.number().int().nonnegative(),
  pullRequests: z.number().int().nonnegative(),
  /** Repositories connected during this pass so their issues could be imported. */
  connected: z.array(z.string()),
});
export type ProjectRefreshDto = z.infer<typeof projectRefreshDto>;

/** A full re-read: every page, and what the whole walk moved. */
export const projectScanDto = projectRefreshDto.extend({
  pages: z.number().int().nonnegative(),
});
export type ProjectScanDto = z.infer<typeof projectScanDto>;

export const setProjectValueInput = z.object({
  projectId: idSchema,
  itemId: idSchema,
  fieldId: idSchema,
  /** Null clears the cell, which every provider distinguishes from an empty value. */
  value: projectFieldValueSchema.nullable(),
});
export type SetProjectValueInput = z.infer<typeof setProjectValueInput>;

/**
 * What the provider now holds, after a write.
 *
 * Not an echo of the input: a provider may normalise a value, or refuse part of it, and
 * rendering what was typed would show the operator their own input as though it were stored
 * (F23 FR-4, NFR-7).
 */
export const projectValueDto = z.object({
  itemId: idSchema,
  fieldId: idSchema,
  value: projectFieldValueSchema.nullable(),
});
export type ProjectValueDto = z.infer<typeof projectValueDto>;

/**
 * Every row of a Project, with an honest statement of whether "every" was reached.
 *
 * `truncated` exists so a rollup, a filter and a roadmap can each say they answered over part of
 * the project rather than presenting a partial answer as a whole one.
 */
export const projectItemsDto = z.object({
  items: z.array(projectItemDto),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ProjectItemsDto = z.infer<typeof projectItemsDto>;

/**
 * What an import actually did.
 *
 * Reported because an import is not one action but four, and because on GitLab one of them
 * *wrote to the operator's repository* — creating the scoped labels a project needs to exist at
 * all. That happens without a confirmation step, so saying afterwards exactly which labels were
 * created, and which were found and left alone, is the least this owes.
 */
export const adoptProjectResultDto = z.object({
  project: projectDto,
  structure: z.object({
    created: z.array(z.string()),
    /** Found already on the provider and deliberately untouched, whatever their colour. */
    existing: z.array(z.string()),
  }),
  issues: z.object({
    imported: z.number().int().nonnegative(),
    repositories: z.number().int().nonnegative(),
  }),
  rows: z.object({
    items: z.number().int().nonnegative(),
    /**
     * Rows still waiting on their Issue after the scan connected what it could.
     *
     * Now genuinely a "not yet": a row is left here only when the provider would not hand over
     * its repository, or when the connect cap deferred it to the next pass. Before repositories
     * were connected on demand this number was a permanent state wearing a temporary word.
     */
    skipped: z.number().int().nonnegative(),
    /** Rows the provider has that a GateControl table will not: every row here is an Issue. */
    drafts: z.number().int().nonnegative(),
    pullRequests: z.number().int().nonnegative(),
    /** Repositories connected to make the rows resolve — named, because it is a write. */
    connected: z.array(z.string()),
    pages: z.number().int().nonnegative(),
  }),
});
export type AdoptProjectResultDto = z.infer<typeof adoptProjectResultDto>;
