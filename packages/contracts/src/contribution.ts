import { z } from "zod";
import { idSchema } from "./common.js";

/**
 * Contribution registries — the shapes that cross a boundary (issue #3).
 *
 * The registry itself is pure logic and lives in `@solow/core`; what lives here is
 * everything that has to survive a round trip: the closed set of arrangeable surfaces, the id
 * grammar, and the arrangement a user saves. They are contracts rather than core types because
 * an arrangement is stored in a row and shipped over tRPC, so it is parsed on the way in and on
 * the way out — a preference written by an older build must never be able to stop the shell
 * rendering.
 */

/**
 * Lowercase segments joined by `.` or `-`: `status.tasks`, `notify.in-app`.
 *
 * The grammar is narrow because an id is a compatibility surface, not an internal handle — a
 * saved arrangement is a list of these, so a renamed id silently discards the user's
 * arrangement for that item, and a plugin manifest (#93) declares ids in the same alphabet.
 */
export const contributionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);

/**
 * The surfaces a user can arrange. Closed on purpose: this string is the key half of a
 * per-user preference row, and a free-form key would let any client write unbounded rows.
 */
/**
 * `project-table` shares one arrangement across every Project, and that is not the compromise it
 * looks like: field ids are unique per project, so an order or a hidden id belonging to another
 * project simply matches nothing and is inert. One row per user, each project filtering it to
 * its own fields.
 */
export const surfaceKeySchema = z.enum([
  "status-bar",
  "commands",
  "notifications",
  "project-table",
]);
export type SurfaceKey = z.infer<typeof surfaceKeySchema>;

/**
 * A stored arrangement is user-supplied and unbounded in principle, so both lists are capped.
 * Well above any plausible number of contributions, low enough that a preference row cannot be
 * used as storage.
 */
const MAX_ARRANGED_IDS = 200;

/**
 * What a stored column width may be.
 *
 * Below the minimum a column cannot show its own header, which makes the table unreadable in a
 * way the person who dragged it there cannot undo without knowing which column they broke. Above
 * the maximum one column pushes the rest off screen.
 */
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 900;

export const surfaceLayoutSchema = z.object({
  /**
   * A partial list on purpose: an item added by an upgrade (or by a plugin installed yesterday)
   * is not in a layout saved last month, and blanking it or shoving it to the front would both
   * be wrong. Anything unnamed falls in behind the named ids at its registered priority.
   */
  order: z.array(contributionIdSchema).max(MAX_ARRANGED_IDS).readonly(),
  hidden: z.array(contributionIdSchema).max(MAX_ARRANGED_IDS).readonly(),
  /**
   * Explicitly turned **on**, overriding a surface's own default.
   *
   * The third state, and it has to exist. A surface may hide something by default — the project
   * table hides a column the provider reports read-only and fills in for no row, because that
   * column is a padlock and a dash on every line — and "the user has not decided" then has to be
   * tellable from "the user turned it back on". With only `hidden`, the two are the same absence,
   * and the default would silently re-hide a column the moment the page reloaded.
   *
   * Optional so every layout saved before this existed still parses, and empty by default: no
   * entry here means the surface's own default decides.
   */
  shown: z.array(contributionIdSchema).max(MAX_ARRANGED_IDS).readonly().default([]),
  /**
   * Per-item pixel widths, for a surface whose items are columns.
   *
   * Only the project table uses this; the status bar and the palette have nothing to size. It
   * lives here anyway rather than in a table-specific store because it is the same *kind* of
   * fact as `order` and `hidden` — this person's arrangement of this surface — and a second
   * preference row for it would be a second thing to keep in step.
   *
   * Bounded on both ends: a column narrower than `MIN_COLUMN_WIDTH` cannot show its own header,
   * and one wider than `MAX_COLUMN_WIDTH` pushes every other column off screen. A stored value is
   * user-supplied, so it is clamped on the way in rather than trusted.
   */
  widths: z
    .record(contributionIdSchema, z.number().int().min(MIN_COLUMN_WIDTH).max(MAX_COLUMN_WIDTH))
    .default({}),
});

/**
 * The parsed arrangement. Readonly because every consumer replaces a layout rather than
 * mutating one — the surfaces, the arrangement UI and the row all hold the same value, and one
 * of them editing an array in place would change what the others believe is saved.
 */
export type SurfaceLayout = z.infer<typeof surfaceLayoutSchema>;

/** No arrangement saved yet: everything visible, in registered priority order. */
export const DEFAULT_SURFACE_LAYOUT: SurfaceLayout = {
  order: [],
  hidden: [],
  shown: [],
  widths: {},
};

export const getSurfaceLayoutInput = z.object({ surface: surfaceKeySchema });
export type GetSurfaceLayoutInput = z.infer<typeof getSurfaceLayoutInput>;

export const setSurfaceLayoutInput = z.object({
  surface: surfaceKeySchema,
  layout: surfaceLayoutSchema,
});
export type SetSurfaceLayoutInput = z.infer<typeof setSurfaceLayoutInput>;

/**
 * An arrangement together with whose it is. The two identity fields are echoed back from the
 * session, never from input (Principle V) — a client that knows which Workspace and which user
 * the server thinks it is talking to can key its cache without inventing a tenant of its own,
 * and a test can assert that one user's arrangement never arrives under another's name.
 */
export const surfaceLayoutDto = z.object({
  surface: surfaceKeySchema,
  workspaceId: idSchema,
  userId: idSchema,
  layout: surfaceLayoutSchema,
});
export type SurfaceLayoutDto = z.infer<typeof surfaceLayoutDto>;

/**
 * The `ui_preference.key` an arrangement is stored under. One column serves every kind of UI
 * preference, so the surface key is namespaced rather than occupying the whole key.
 */
export function surfaceLayoutPreferenceKey(surface: SurfaceKey): string {
  return `surface-layout:${surface}`;
}

/**
 * The Task page's split: the terminal on the left, the change under review in a column on the
 * right, the way a source-control panel sits beside an editor.
 *
 * It lives beside the surface-layout schemas because both are rows of `ui_preference` and share
 * its one JSON column — but it is deliberately its own schema rather than another `SurfaceKey`.
 * A contributed surface's arrangement is an order and a hidden list; a pane is a width and a
 * fold. Forcing one shape to mean both would make `surfaceLayoutSchema` stop describing anything.
 *
 * Bounded on both sides: a stored width of zero would render an invisible column that cannot be
 * grabbed to reopen, and an unbounded one would push the terminal off the page. Values outside
 * the range fall back to the default rather than being clamped, since a value that far out is a
 * corrupt row, not a preference.
 */
export const TASK_PANE_MIN_WIDTH = 240;
export const TASK_PANE_MAX_WIDTH = 900;

export const taskPaneLayoutSchema = z.object({
  changesWidth: z.number().int().min(TASK_PANE_MIN_WIDTH).max(TASK_PANE_MAX_WIDTH),
  changesCollapsed: z.boolean(),
});
export type TaskPaneLayout = z.infer<typeof taskPaneLayoutSchema>;

/** Wide enough for a file list and a patch's leading columns without crowding the terminal. */
export const DEFAULT_TASK_PANE_LAYOUT: TaskPaneLayout = {
  changesWidth: 420,
  changesCollapsed: false,
};

export const setTaskPaneLayoutInput = taskPaneLayoutSchema;
export type SetTaskPaneLayoutInput = z.infer<typeof setTaskPaneLayoutInput>;

/** Echoes the identity back for the same reason `surfaceLayoutDto` does (Principle V). */
export const taskPaneLayoutDto = z.object({
  workspaceId: idSchema,
  userId: idSchema,
  layout: taskPaneLayoutSchema,
});
export type TaskPaneLayoutDto = z.infer<typeof taskPaneLayoutDto>;

/** The single `ui_preference.key` the split is stored under. */
export const TASK_PANE_PREFERENCE_KEY = "task-pane-layout";
