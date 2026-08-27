import {
  contributionIdSchema,
  DEFAULT_SURFACE_LAYOUT,
  err,
  ok,
  type Result,
  type SurfaceKey,
  type SurfaceLayout,
} from "@solow/contracts";

/**
 * Contribution registries (issue #3).
 *
 * Three surfaces want the identical shape — things supplied by feature modules, ordered,
 * conditionally visible, arranged by the user: the command palette, the status bar, and
 * notification delivery. Written three times they drift apart; written once they become the
 * seam a plugin API (#93) needs, because registration is then the only way into a surface and
 * a registration is the only thing a sandbox has to police.
 *
 * Nothing here imports React, the DOM or any infrastructure. `T` is whatever the surface
 * renders with — a component, a `run` callback, a `deliver` function — so the same ordering
 * and visibility rules serve the browser surfaces and, later, the orchestrator-side
 * notification dispatcher (#92).
 */

export interface Contribution<T, Ctx> {
  /**
   * Stable, dotted, lowercase: `status.tasks`, `settings.secrets`, `notify.in-app`. This is not
   * an internal handle — a saved arrangement is a list of these ids, so renaming one silently
   * discards the user's arrangement for that item.
   */
  readonly id: string;
  /** Ascending. A default only: the user's saved arrangement outranks it. */
  readonly priority: number;
  /** Visibility, evaluated at render time. Absent means "always visible". */
  readonly when?: (ctx: Ctx) => boolean;
  /** Whatever this surface needs in order to show or run the contribution. */
  readonly render: T;
}

/**
 * A user's arrangement of one surface, the key naming the surface itself, and the arrangement
 * that means "nothing saved yet" — all defined in `@solow/contracts` and re-exported here
 * so a caller working with a registry does not have to know that an arrangement is also a
 * stored, parsed thing. There is one definition of each: an arrangement crosses the wire and a
 * preference row, so the parse boundary owns it.
 */
export type { SurfaceKey, SurfaceLayout } from "@solow/contracts";
export { DEFAULT_SURFACE_LAYOUT } from "@solow/contracts";

export const RegistryErrorCode = {
  DuplicateId: "REGISTRY_DUPLICATE_ID",
  InvalidId: "REGISTRY_INVALID_ID",
} as const;
export type RegistryErrorCode = (typeof RegistryErrorCode)[keyof typeof RegistryErrorCode];

/** The id grammar a saved layout and a plugin manifest share, applied without a parse result. */
export function isValidContributionId(id: string): boolean {
  return contributionIdSchema.safeParse(id).success;
}

/**
 * A predicate that throws counts as "not visible" rather than propagating. These run inside a
 * surface's render, and #93 will let third-party code supply them: one broken plugin must cost
 * its own item, not the whole status bar.
 */
function isVisible<T, Ctx>(contribution: Contribution<T, Ctx>, ctx: Ctx): boolean {
  if (!contribution.when) return true;
  try {
    return contribution.when(ctx) === true;
  } catch {
    return false;
  }
}

/**
 * Ordering alone, filtering nothing. This is what a customization UI needs: a list to arrange
 * has to include the items the user has hidden (otherwise they can never be brought back) and
 * the items a predicate is currently hiding (you are arranging the surface, not looking at it).
 *
 * The comparison is total — saved position, then priority, then id — so two devices showing the
 * same contributions show them in the same sequence. Falling back on registration order instead
 * would make the sequence depend on module evaluation order, which a bundler is free to change.
 */
export function arrangeContributions<T, Ctx>(
  contributions: readonly Contribution<T, Ctx>[],
  layout: SurfaceLayout = DEFAULT_SURFACE_LAYOUT,
): Contribution<T, Ctx>[] {
  const savedPosition = new Map(layout.order.map((id, index) => [id, index]));
  const rank = (id: string) => savedPosition.get(id) ?? Number.POSITIVE_INFINITY;

  // Two unarranged ids give `Infinity - Infinity`, which is NaN and therefore falsy, so the
  // comparison falls through to priority — which is exactly what should decide between them.
  return [...contributions].sort(
    (a, b) => rank(a.id) - rank(b.id) || a.priority - b.priority || a.id.localeCompare(b.id),
  );
}

/**
 * What a surface should render right now: the user's arrangement, minus what they hid, minus
 * what the context says does not apply. Pure, so the rules can be tested without a registry
 * instance and reused by callers holding a list from somewhere else.
 */
export function resolveContributions<T, Ctx>(
  contributions: readonly Contribution<T, Ctx>[],
  ctx: Ctx,
  layout: SurfaceLayout = DEFAULT_SURFACE_LAYOUT,
): Contribution<T, Ctx>[] {
  const hidden = new Set(layout.hidden);
  return arrangeContributions(
    contributions.filter((c) => !hidden.has(c.id) && isVisible(c, ctx)),
    layout,
  );
}

/**
 * Move one contribution a single slot within an arrangement. `order` must be the ids as the user
 * currently sees them listed, not the saved partial list — moving an item relative to a list it
 * is not in has no meaning, and the result is what gets saved, so it has to be complete.
 */
export function moveInOrder(order: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  next[from] = order[to] as string;
  next[to] = id;
  return next;
}

/**
 * Show or hide one contribution, leaving the arrangement's order untouched.
 *
 * Both lists are written, because visibility is now a three-state: showing an item records it in
 * `shown` so a surface default cannot re-hide it on the next load, and hiding one clears that
 * record. Writing only `hidden` would leave a stale `shown` behind, and the item would come back.
 */
export function withVisibility(layout: SurfaceLayout, id: string, visible: boolean): SurfaceLayout {
  const hidden = layout.hidden.filter((h) => h !== id);
  const shown = layout.shown.filter((s) => s !== id);
  return {
    order: [...layout.order],
    hidden: visible ? hidden : [...hidden, id],
    shown: visible ? [...shown, id] : shown,
    // Untouched: a column's width is not a fact about whether it is on screen, and dropping it
    // here would reset every width the moment someone hid one column.
    widths: { ...layout.widths },
  };
}

export interface Registry<T, Ctx> {
  /**
   * The surface these contributions belong to, and the key its arrangement is saved under —
   * one value, not a registry-side name that happens to match a literal at the call site.
   * Consumers pass `registry.surface` to the layout store rather than repeating the string, so
   * renaming a surface cannot leave the registry and the saved arrangement addressing
   * different things.
   */
  readonly surface: SurfaceKey;
  /**
   * Returns a Result rather than throwing. #93 feeds third-party ids into this at load time, and
   * a plugin declaring an id another plugin already took must be a rejected registration, not a
   * shell that fails to boot. The first registration of an id wins.
   */
  register(contribution: Contribution<T, Ctx>): Result<Contribution<T, Ctx>, RegistryErrorCode>;
  /**
   * Removes a registration, returning whether there was one to remove.
   *
   * Registration without removal would be a one-way door: #93's loader has to be able to
   * uninstall a plugin, and hiding its contributions through the user's layout is not the same
   * thing — the ids would stay listed wherever the surface is arranged, offering to restore
   * something that is gone. It also gives a re-evaluated module (Fast Refresh) and a test a way
   * to put a registry back the way they found it, instead of leaving a contribution behind for
   * whatever loads next.
   */
  unregister(id: string): boolean;
  /** Everything registered, in registration order and unfiltered. */
  list(): readonly Contribution<T, Ctx>[];
  /** What this surface should render right now, in the order it should render it. */
  resolve(ctx: Ctx, layout?: SurfaceLayout): Contribution<T, Ctx>[];
}

export function createRegistry<T, Ctx>(surface: SurfaceKey): Registry<T, Ctx> {
  const contributions = new Map<string, Contribution<T, Ctx>>();

  return {
    surface,
    register(contribution) {
      if (!isValidContributionId(contribution.id)) return err(RegistryErrorCode.InvalidId);
      if (contributions.has(contribution.id)) return err(RegistryErrorCode.DuplicateId);
      contributions.set(contribution.id, contribution);
      return ok(contribution);
    },
    unregister(id) {
      return contributions.delete(id);
    },
    list() {
      return [...contributions.values()];
    },
    resolve(ctx, layout) {
      return resolveContributions([...contributions.values()], ctx, layout);
    },
  };
}
