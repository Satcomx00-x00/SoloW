import { projectViewConfigSchema } from "@solow/contracts";

/**
 * The unsaved on-screen tweaks to a Project view — layout, grouping, sort, visible columns,
 * hide-closed — kept in *this browser* so a refresh does not throw them away (user report: "Hide
 * closed" and the rest of the toolbar reset on reload).
 *
 * Deliberately `localStorage`, not the server-side preference channel column widths and the
 * status bar's arrangement use. `project-view.tsx`'s own comment on `draft` already states the
 * intent this has to respect: these are "changes made on screen but not yet saved to the tab",
 * held apart from the shared view specifically so narrowing `In review` to one person's work does
 * not re-point the team's tab until somebody clicks Save. Syncing that same draft to every device
 * over the account would turn a fleeting "what if I group by size" into a cross-device default
 * nobody chose — a *device-local* memory is the right amount of durability for a value the code
 * elsewhere already treats as disposable.
 *
 * `filter` is excluded on purpose: it already lives in the URL's `?q=`, which is what a saved
 * view stores and what makes a narrowed tab a link you can send someone. Persisting it a second
 * way here would give the filter box two sources of truth that could disagree.
 */
const draftOverlaySchema = projectViewConfigSchema.omit({ filter: true }).partial();

// Inferred from the schema rather than hand-written as `Partial<Omit<ProjectViewConfig, "filter">>`:
// under `exactOptionalPropertyTypes`, TS's own `Partial` produces `key?: T`, while a parsed zod
// optional is `key?: T | undefined` — two types that look identical and are not, and the mismatch
// only shows up as a build error at the one call site that assigns a parse result to the hand-
// written one.
export type ProjectViewDraftOverlay = ReturnType<typeof draftOverlaySchema.parse>;

function storageKey(projectId: string, viewKey: string): string {
  return `solow:project-view-draft:${projectId}:${viewKey}`;
}

/**
 * The stored overlay for one Project's one tab, or `{}` when there is none — a missing key, a
 * private window, cleared site data, and a value written by an older build (or edited by hand)
 * all land here rather than throwing. A draft is a convenience; it must never be able to stop the
 * page rendering, the same rule every server-side preference in this app already follows.
 */
export function readDraftOverlay(projectId: string, viewKey: string): ProjectViewDraftOverlay {
  try {
    const raw = window.localStorage.getItem(storageKey(projectId, viewKey));
    if (!raw) return {};
    const parsed = draftOverlaySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** Saves the overlay, or removes the key entirely once nothing is left to remember. */
export function writeDraftOverlay(
  projectId: string,
  viewKey: string,
  overlay: ProjectViewDraftOverlay,
): void {
  try {
    if (Object.keys(overlay).length === 0) {
      window.localStorage.removeItem(storageKey(projectId, viewKey));
      return;
    }
    window.localStorage.setItem(storageKey(projectId, viewKey), JSON.stringify(overlay));
  } catch {
    // Storage unreachable (a private window, a browser set to block site data): the draft simply
    // does not survive a refresh, which is exactly the state this file exists to improve on —
    // never worse than before it existed.
  }
}

/** Forgets the overlay — called once its contents are written into the saved view itself. */
export function clearDraftOverlay(projectId: string, viewKey: string): void {
  try {
    window.localStorage.removeItem(storageKey(projectId, viewKey));
  } catch {
    // Nothing to clean up if storage was never reachable.
  }
}
