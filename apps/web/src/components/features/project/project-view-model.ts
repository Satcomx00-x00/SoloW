import type { ProjectFieldDto, ProjectFieldValue, ProjectViewConfig } from "@gatecontrol/contracts";
import { PROJECT_TITLE_KEY } from "@gatecontrol/contracts";
import {
  type FilterableItem,
  matchesProjectFilter,
  normaliseFilterKey,
  type ProjectFilterContext,
} from "@gatecontrol/core";
import type { ProjectRow } from "@/components/features/project/project-table";

/**
 * Turning a saved view into the rows one tab shows (spec F23 FR-9 … FR-11, issue #129).
 *
 * A view names *fields*, and a row holds *values*; this module is the join between the two, and
 * it is the only place that knows how a stored value reads to a filter. Pure and free of React
 * so the language can be tested against rows rather than against a rendered table — the filter
 * is data, and evaluating it is arithmetic.
 *
 * Nothing here copies an item. Every tab is handed the same rows and returns a subset of them in
 * an order, which is what makes an edit under one tab an edit under all of them (F23 AC-6).
 */

/**
 * One row, as the filter and the table both see it.
 *
 * `labels` used to live here, beside the row, because only the filter needed them. The table
 * renders them now too (§7), and two copies of one fact is one copy too many — a filter matching
 * a set of labels the cell did not draw is a bug nobody would look for. They live on the row,
 * which is the thing both halves already hold.
 */
export interface ProjectViewItem {
  row: ProjectRow;
}

/**
 * What one value offers a filter, as separate values rather than as one rendered string.
 *
 * `formatValue` joins assignees with a comma because that is how a cell reads; a filter has to
 * match one of them, so `assignee:ana` cannot be asked of `"satcom, ana"`. Two readings of one
 * value, and conflating them would make the second wrong.
 */
export function filterValuesFor(
  value: ProjectFieldValue | undefined,
  field: ProjectFieldDto,
): string[] {
  if (!value) return [];
  switch (value.type) {
    case "text":
      return [value.text];
    case "number":
      return [String(value.number)];
    case "date":
      return [value.date];
    case "url":
      return [value.url];
    case "single_select":
      // Filtered by the option's *name*: `status:"In progress"` is what a person can see and
      // type. The provider's option id is a string nobody has ever read off a screen.
      return [field.options.find((o) => o.id === value.optionId)?.name ?? value.optionId];
    case "iteration":
      return [field.iterations.find((i) => i.id === value.iterationId)?.title ?? value.iterationId];
    case "user":
      return value.users.map((u) => u.login);
    default:
      return [];
  }
}

/**
 * Register a value under the key a person would type.
 *
 * A column called `Assignees` is asked about as `assignee:`, because that is how the question is
 * said out loud — and the spec's own example says exactly that. So a plural key is also
 * registered singular, unless a real column already holds that name: a field the project
 * actually has always outranks an alias invented here.
 */
function register(into: Record<string, string[]>, key: string, values: string[]): void {
  if (key === "") return;
  into[key] = [...(into[key] ?? []), ...values];
  const singular = key.endsWith("s") ? key.slice(0, -1) : null;
  if (singular && singular !== "" && into[singular] === undefined) into[singular] = values;
}

/** A row reduced to what the filter language can ask about. */
export function filterableItemFor(
  item: ProjectViewItem,
  fields: readonly ProjectFieldDto[],
): FilterableItem {
  const bag: Record<string, string[]> = {};
  for (const field of fields) {
    register(
      bag,
      normaliseFilterKey(field.name),
      filterValuesFor(item.row.item.values[field.id], field),
    );
  }
  // The Issue's own facts, under the names the spec's example uses. Registered after the fields
  // so a project that has a column called `Labels` keeps its own meaning of the word.
  register(bag, "label", [...item.row.labels]);
  return { title: item.row.title, fields: bag };
}

/**
 * What `@current` means today, per iteration field.
 *
 * Computed here rather than stored in the view: `iteration:@current` saved in August has to
 * still mean the current iteration in September, or a shared tab is a snapshot of somebody's
 * Monday. An iteration field with nothing running right now resolves to nothing, and the clause
 * matches no rows — which is the truth, not an error.
 */
export function currentIterationsFor(
  fields: readonly ProjectFieldDto[],
  now: Date,
): Record<string, string[]> {
  const today = now.toISOString().slice(0, 10);
  const current: Record<string, string[]> = {};
  for (const field of fields) {
    const running = field.iterations.filter((i) => i.startDate <= today && today <= i.endDate);
    if (running.length > 0)
      register(
        current,
        normaliseFilterKey(field.name),
        running.map((i) => i.title),
      );
  }
  return current;
}

/** How one row sorts under one column: numbers as numbers, and "unset" always last. */
function sortKey(
  row: ProjectRow,
  field: ProjectFieldDto | null,
): { empty: boolean; number: number | null; text: string } {
  if (!field) return { empty: row.title === "", number: null, text: row.title.toLowerCase() };
  const value = row.item.values[field.id];
  const values = value ? filterValuesFor(value, field) : [];
  const text = values.join(", ");
  return {
    empty: text === "",
    number: value?.type === "number" ? value.number : null,
    text: text.toLowerCase(),
  };
}

/**
 * The rows one view shows, in its order.
 *
 * Filter then sort, and neither step mutates the input: the caller holds one array of rows for
 * the whole screen, and a tab that sorted it in place would reorder every other tab with it.
 *
 * An unset value sorts last in **both** directions. Reversing a sort should not put the empty
 * cells first — nobody asks "sort by target date, descending" in order to read the rows that
 * have no target date.
 */
export function applyProjectView(
  items: readonly ProjectViewItem[],
  fields: readonly ProjectFieldDto[],
  config: ProjectViewConfig,
  ctx: { me?: string | null; now?: Date } = {},
): ProjectRow[] {
  const filterCtx: ProjectFilterContext = {
    me: ctx.me ?? null,
    current: currentIterationsFor(fields, ctx.now ?? new Date()),
  };

  const kept = items.filter((item) =>
    matchesProjectFilter(config.filter, filterableItemFor(item, fields), filterCtx),
  );
  const rows = kept.map((item) => item.row);
  if (!config.sort) return rows;

  const field =
    config.sort.field === PROJECT_TITLE_KEY
      ? null
      : (fields.find((f) => f.id === config.sort?.field) ?? null);
  // A sort naming a column this project no longer has leaves the mirror's own order alone. The
  // alternative — sorting every row by an empty key — looks like a shuffle nobody asked for.
  if (!field && config.sort.field !== PROJECT_TITLE_KEY) return rows;

  const direction = config.sort.direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    const left = sortKey(a, field);
    const right = sortKey(b, field);
    if (left.empty !== right.empty) return left.empty ? 1 : -1;
    if (left.number !== null && right.number !== null) {
      return (left.number - right.number) * direction;
    }
    return left.text.localeCompare(right.text) * direction;
  });
}

/**
 * The view's column set, expressed the way the table already asks for it.
 *
 * The table hides; a view shows. Translated here rather than by teaching the table a second
 * vocabulary — and null (every column) has to become an empty hidden list, or a view saved
 * before a sync added a field would hide the field it has never heard of.
 */
export function hiddenFieldIdsFor(
  fields: readonly ProjectFieldDto[],
  visibleFieldIds: readonly string[] | null,
): string[] {
  if (visibleFieldIds === null) return [];
  return fields.filter((f) => !visibleFieldIds.includes(f.id)).map((f) => f.id);
}
