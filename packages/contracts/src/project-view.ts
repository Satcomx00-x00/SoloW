import { z } from "zod";
import { idSchema, timestampsSchema } from "./common.js";

/**
 * Saved views over one Project (spec F23 FR-9 … FR-11, issue #129).
 *
 * A view is a **saved configuration, never a copy of the data**: a name, a layout, a filter, a
 * grouping, a sort and a visible column set. Every tab reads the same items, so a value edited
 * under one tab is edited under all of them — there is only ever one set of rows.
 *
 * The filter is stored as a *predicate*, not as the text somebody typed and not as a function.
 * That is the whole reason this file exists: a closure cannot be written to a row, and a raw
 * string means every reader re-implements the language. A parsed predicate round-trips through
 * storage, and `@solow/core`'s parser is the only thing that has to know the syntax.
 */

/**
 * One clause of a filter.
 *
 * Clauses are ANDed; the values inside a field clause are ORed — `status:Todo,Doing` is "either
 * of those", `status:Todo size:XL` is "both". `negated` inverts the clause it sits on rather
 * than the whole filter, which is what makes `-label:blocked` mean what it reads as.
 */
export const projectFilterTermSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("keyword"),
    negated: z.boolean(),
    /** Matched as a case-insensitive substring of the row's title — the bare case (FR-11). */
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal("field"),
    negated: z.boolean(),
    /**
     * The field this clause names, normalised (`normaliseFilterKey`): lower-case, punctuation
     * dropped. Stored by *name* rather than by the field's id on purpose — a view outlives a
     * re-sync that gives the same column a new row id, and a filter that silently stopped
     * matching after a sync would be worse than one that names a field nobody has.
     */
    field: z.string().min(1),
    values: z.array(z.string()).min(1),
  }),
]);
export type ProjectFilterTerm = z.infer<typeof projectFilterTermSchema>;

export const projectFilterSchema = z.object({ terms: z.array(projectFilterTermSchema) });
export type ProjectFilter = z.infer<typeof projectFilterSchema>;

/** No clauses — every row passes. Frozen so a shared default cannot be mutated into a filter. */
export const EMPTY_PROJECT_FILTER: ProjectFilter = Object.freeze({ terms: [] });

/**
 * The two projections of one item set (FR-10).
 *
 * A layout is a *projection, not a second model* — the same phrasing issue #61 uses for the DAG
 * view, and the same rule: the roadmap lays the very rows the table shows on a timeline. Nothing
 * is duplicated and nothing is computed twice.
 */
export const projectViewLayoutSchema = z.enum(["table", "roadmap"]);
export type ProjectViewLayout = z.infer<typeof projectViewLayoutSchema>;

/**
 * Sorting by a column, or by the row's title.
 *
 * The title is not a project field — it belongs to the Issue the row projects — so it needs a
 * key that cannot collide with a field id. The `@` prefix is the filter language's own escape
 * for "not a literal", reused rather than reinvented.
 */
export const PROJECT_TITLE_KEY = "@title";

export const projectSortSchema = z.object({
  /** A `projectFieldDto.id`, or `PROJECT_TITLE_KEY`. */
  field: z.string().min(1),
  direction: z.enum(["asc", "desc"]),
});
export type ProjectSort = z.infer<typeof projectSortSchema>;

export const projectViewConfigSchema = z.object({
  layout: projectViewLayoutSchema,
  filter: projectFilterSchema,
  /** A single-select field id, as the table's grouping already means. Null renders one list. */
  groupByFieldId: z.string().nullable(),
  sort: projectSortSchema.nullable(),
  /**
   * Which columns this view shows. **Null means every column**, which is not the same as an
   * empty list: a view saved before a sync added a field should show that field, and a view
   * whose author hid everything should show nothing. Conflating the two would make one of those
   * two views a lie.
   */
  visibleFieldIds: z.array(z.string()).nullable(),
  /**
   * Leave finished work out of the rows this view draws.
   *
   * Closed on the **provider**, which is `projectItemDto.closed` — not a Status field reading
   * "Done". A Status is a team's convention and a convention is not a completion; a project that
   * ships work under a status called `Released` would otherwise keep every one of those rows.
   *
   * Defaulted rather than required: every view saved before this existed must keep showing
   * everything, because hiding rows from somebody's saved tab is not a migration, it is a change
   * to what their tab means.
   */
  hideClosed: z.boolean().default(false),
});
export type ProjectViewConfig = z.infer<typeof projectViewConfigSchema>;

/** What a brand new tab holds: everything, unfiltered, as a table. */
export const DEFAULT_PROJECT_VIEW_CONFIG: ProjectViewConfig = {
  layout: "table",
  filter: EMPTY_PROJECT_FILTER,
  groupByFieldId: null,
  sort: null,
  visibleFieldIds: null,
  hideClosed: false,
};

export const projectViewDto = z
  .object({
    id: idSchema,
    projectId: idSchema,
    name: z.string(),
    /** Tab order, ascending. The order the team put them in, not an alphabetisation. */
    position: z.number().int().nonnegative(),
    config: projectViewConfigSchema,
  })
  .merge(timestampsSchema);
export type ProjectViewDto = z.infer<typeof projectViewDto>;

/** A tab's name. Short, because it is a tab — a sentence there is a filter that wants saving. */
export const projectViewNameSchema = z.string().trim().min(1).max(60);

export const listProjectViewsInput = z.object({ projectId: idSchema });
export type ListProjectViewsInput = z.infer<typeof listProjectViewsInput>;

export const createProjectViewInput = z.object({
  projectId: idSchema,
  name: projectViewNameSchema,
  /** Absent means the default configuration — a new tab is not required to arrive configured. */
  config: projectViewConfigSchema.optional(),
});
export type CreateProjectViewInput = z.infer<typeof createProjectViewInput>;

/**
 * Rename a view, reconfigure it, or both.
 *
 * Both optional and both independent: renaming a tab must not have to resend a configuration the
 * caller may be holding a stale copy of, which is how a rename quietly reverts somebody's filter.
 */
export const updateProjectViewInput = z.object({
  viewId: idSchema,
  name: projectViewNameSchema.optional(),
  config: projectViewConfigSchema.optional(),
});
export type UpdateProjectViewInput = z.infer<typeof updateProjectViewInput>;

/**
 * The whole tab strip, in its new order.
 *
 * Every id at once rather than "move this one to index n": a partial reorder has to be applied
 * against an order the caller may no longer be looking at, and two people dragging tabs would
 * interleave into an order neither chose.
 */
export const reorderProjectViewsInput = z.object({
  projectId: idSchema,
  viewIds: z.array(idSchema).min(1),
});
export type ReorderProjectViewsInput = z.infer<typeof reorderProjectViewsInput>;

export const projectViewIdInput = z.object({ viewId: idSchema });
export type ProjectViewIdInput = z.infer<typeof projectViewIdInput>;
