import { z } from "zod";
import { idSchema } from "./common.js";

/**
 * Contribution registries — the shapes that cross a boundary (issue #3).
 *
 * The registry itself is pure logic and lives in `@gatecontrol/core`; what lives here is
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
export const surfaceKeySchema = z.enum(["status-bar", "commands", "notifications"]);
export type SurfaceKey = z.infer<typeof surfaceKeySchema>;

/**
 * A stored arrangement is user-supplied and unbounded in principle, so both lists are capped.
 * Well above any plausible number of contributions, low enough that a preference row cannot be
 * used as storage.
 */
const MAX_ARRANGED_IDS = 200;

export const surfaceLayoutSchema = z.object({
  /**
   * A partial list on purpose: an item added by an upgrade (or by a plugin installed yesterday)
   * is not in a layout saved last month, and blanking it or shoving it to the front would both
   * be wrong. Anything unnamed falls in behind the named ids at its registered priority.
   */
  order: z.array(contributionIdSchema).max(MAX_ARRANGED_IDS).readonly(),
  hidden: z.array(contributionIdSchema).max(MAX_ARRANGED_IDS).readonly(),
});

/**
 * The parsed arrangement. Readonly because every consumer replaces a layout rather than
 * mutating one — the surfaces, the arrangement UI and the row all hold the same value, and one
 * of them editing an array in place would change what the others believe is saved.
 */
export type SurfaceLayout = z.infer<typeof surfaceLayoutSchema>;

/** No arrangement saved yet: everything visible, in registered priority order. */
export const DEFAULT_SURFACE_LAYOUT: SurfaceLayout = { order: [], hidden: [] };

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
