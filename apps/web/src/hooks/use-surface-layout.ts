"use client";

import {
  DEFAULT_SURFACE_LAYOUT,
  moveInOrder,
  type SurfaceKey,
  type SurfaceLayout,
  withVisibility,
} from "@solow/core";
import { useCallback } from "react";
import { trpc } from "@/trpc/react";

/**
 * One surface's arrangement, and the two edits a user can make to it (issue #3, AC-3).
 *
 * Shared by the bar and by the Settings section that reorders it, so the two cannot disagree
 * about what an arrangement is or how a move is expressed — and, because both read the same
 * query, a change made in Settings moves the bar in the same paint rather than after a reload.
 *
 * The arrangement lives in a `ui_preference` row, not in this browser. That is the whole of
 * AC-3: an arrangement belongs to a person inside a Workspace, so it is restored by signing in
 * rather than by returning to the machine it was made on. There is deliberately no client-side
 * store behind this: the query cache already is one, and a second copy of the same state is the
 * divergence issue #3 exists to prevent. It is also why nothing here names a Workspace or a user
 * — the server takes both from the session (Principle V), which no client can talk it out of.
 */
export interface SurfaceLayoutHandle {
  layout: SurfaceLayout;
  /**
   * `visibleOrder` is the ids as the user currently sees them listed, not the saved partial
   * list: the result is what gets saved, so it has to name every item or the ones it omits fall
   * back to priority and appear to jump.
   */
  move(visibleOrder: readonly string[], id: string, delta: -1 | 1): void;
  setVisible(id: string, visible: boolean): void;
}

export function useSurfaceLayout(surface: SurfaceKey): SurfaceLayoutHandle {
  const utils = trpc.useUtils();
  const saved = trpc.preference.getSurfaceLayout.useQuery({ surface });
  const save = trpc.preference.setSurfaceLayout.useMutation({
    /**
     * Settled, not succeeded: what the surface shows afterwards is whatever the server actually
     * holds, whether the save worked or not. A rearrangement that failed has to stop looking
     * like it saved, or the next reload silently undoes what the user just did — and re-reading
     * rather than trusting the reply is also what keeps two quick moves converging, since the
     * reply to the first one only knows about the first one.
     */
    onSettled: () => utils.preference.getSurfaceLayout.invalidate({ surface }),
  });

  const layout = saved.data?.layout ?? DEFAULT_SURFACE_LAYOUT;

  /**
   * Written into the cache before the round trip: a status bar that reorders a moment after the
   * click reads as a bug, and every consumer of this surface reads this one query, so one cache
   * write moves all of them together.
   */
  const apply = useCallback(
    (next: SurfaceLayout) => {
      utils.preference.getSurfaceLayout.setData({ surface }, (previous) =>
        previous ? { ...previous, layout: next } : previous,
      );
      save.mutate({
        surface,
        layout: { order: [...next.order], hidden: [...next.hidden], shown: [], widths: {} },
      });
    },
    [save, surface, utils],
  );

  const move = useCallback(
    (visibleOrder: readonly string[], id: string, delta: -1 | 1) => {
      apply({
        order: moveInOrder(visibleOrder, id, delta),
        hidden: layout.hidden,
        shown: layout.shown,
        widths: layout.widths,
      });
    },
    [apply, layout.hidden, layout.shown, layout.widths],
  );

  const setVisible = useCallback(
    (id: string, visible: boolean) => apply(withVisibility(layout, id, visible)),
    [apply, layout],
  );

  return { layout, move, setVisible };
}
