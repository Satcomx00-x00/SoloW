"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Row windowing for a long table (spec F23 NFR-1, issue #126).
 *
 * Written here rather than pulled in as a dependency: what a fixed-height table needs is a
 * scroll position, a row height and two slice indexes, and a virtualization library brings
 * measurement, dynamic heights and an observer graph for the general case this is not.
 *
 * A project is large on day one. Rendering a thousand rows costs a thousand DOM nodes per column
 * and makes every poll a full re-layout — the lesson issue #68 already recorded for the file
 * tree: virtualize from the start, because the first real repository is the one that breaks it.
 */

export interface VirtualWindow {
  /** First row to render. */
  start: number;
  /** One past the last row to render. */
  end: number;
  /** Spacer height above the rendered rows, in pixels. */
  paddingTop: number;
  /** Spacer height below them. */
  paddingBottom: number;
}

/**
 * How many rows to render beyond the viewport on each side.
 *
 * Not zero: a scroll paints before React re-renders, and a window with no margin shows blank
 * bands at the edges while it catches up. Three rows is enough to hide that at ordinary scroll
 * speeds without meaningfully changing the node count.
 */
const OVERSCAN = 3;

export function windowFor(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
): VirtualWindow {
  // Unmeasured, or nothing to measure: render everything. A caller that has not laid out yet
  // must not be handed a six-row window computed from a zero-height viewport — that is a table
  // that renders a sliver and then jumps.
  if (rowHeight <= 0 || viewportHeight <= 0 || rowCount === 0) {
    return { start: 0, end: rowCount, paddingTop: 0, paddingBottom: 0 };
  }
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const visible = Math.ceil(viewportHeight / rowHeight) + OVERSCAN * 2;
  const last = Math.min(rowCount, first + visible);
  return {
    start: first,
    end: last,
    paddingTop: first * rowHeight,
    paddingBottom: Math.max(0, (rowCount - last) * rowHeight),
  };
}

/**
 * Track a scroll container and report which rows to render.
 *
 * Returns the whole range until the container has been measured, so the first paint is correct
 * rather than empty — a table that renders nothing until an effect runs flashes blank on every
 * navigation, and on a short list it would never need to window at all.
 */
export function useVirtualRows(rowCount: number, rowHeight: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const onScroll = useCallback(() => {
    const node = ref.current;
    if (node) setScrollTop(node.scrollTop);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setViewportHeight(node.clientHeight);
    // The container's height changes with the window and with a panel being dragged, and a stale
    // height renders too few rows — a table that stops half way down its own viewport.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const measured = viewportHeight > 0;
  const window: VirtualWindow = measured
    ? windowFor(scrollTop, viewportHeight, rowHeight, rowCount)
    : { start: 0, end: rowCount, paddingTop: 0, paddingBottom: 0 };

  return { ref, onScroll, window };
}
