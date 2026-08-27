/**
 * Which lines of the table body are worth drawing (spec F23 NFR-1, issue #126 AC-6).
 *
 * A project can hold a thousand items, and every row of this table is expensive in a way a plain
 * list is not: a context menu, a state icon, a task badge, a label list and one editable cell per
 * provider field. Drawing all of them costs the first paint, every subsequent re-render, and the
 * browser's own layout — so the table draws the lines the viewport can actually show, plus a
 * margin, and replaces the rest with two spacers of exactly the right height.
 *
 * The arithmetic lives here, apart from the component, for the reason the hierarchy and the
 * rollup do: it is a claim about numbers, and a claim about numbers should be provable without a
 * DOM. It is also why this takes explicit heights rather than measuring anything — the table's
 * rows are a fixed `ROW_HEIGHT` and its group headings a fixed `GROUP_HEADER_HEIGHT` because they
 * are measurements of the reference (§1), so there is nothing to measure and no first paint spent
 * measuring it.
 */

/**
 * Lines drawn beyond each edge of the viewport.
 *
 * Not an optimisation — a correctness margin. A wheel gesture moves the scroll position between
 * two paints, and a window drawn exactly to the edge shows a strip of empty table for that frame.
 * Eight lines is roughly a third of a screen at `ROW_HEIGHT`, which covers a fast flick without
 * doubling what gets rendered.
 */
export const ROW_OVERSCAN = 8;

export interface RowWindow {
  /** First line to draw, inclusive. */
  from: number;
  /** One past the last line to draw. */
  to: number;
  /** Height of the lines skipped above `from`, and below `to`, in pixels. */
  padTop: number;
  padBottom: number;
}

function sum(heights: readonly number[], start: number, end: number): number {
  let total = 0;
  for (let i = start; i < end; i += 1) total += heights[i] ?? 0;
  return total;
}

/**
 * The window of lines to draw for a scroll position and a viewport height.
 *
 * **A viewport of zero means "draw everything", not "draw nothing".** That case is not
 * hypothetical: it is every render before the first layout pass, and it is every render in a test
 * environment, where no element has a height. Windowing to nothing there would flash an empty
 * table on mount and would make the table untestable — so the honest reading of "I have not been
 * told how tall I am" is to draw the lot and let the next measurement narrow it.
 *
 * The same is true of the returned pads when the window covers the whole list: both are zero, and
 * the caller draws no spacers at all. A table short enough to fit is therefore byte-for-byte the
 * table that existed before this file, which is what keeps virtualization from being a thing that
 * only shows up as a bug on small projects.
 */
export function windowOf(
  heights: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan: number = ROW_OVERSCAN,
): RowWindow {
  const everything: RowWindow = { from: 0, to: heights.length, padTop: 0, padBottom: 0 };
  if (viewport <= 0 || heights.length === 0) return everything;

  const top = Math.max(0, scrollTop);
  const bottom = top + viewport;

  // The first line whose bottom edge is still below the top of the viewport, walking the heights
  // rather than dividing by one of them: the group headings are taller than the rows, so there is
  // no single row height to divide by once a project is grouped.
  let first = 0;
  let offset = 0;
  while (first < heights.length && offset + (heights[first] ?? 0) <= top) {
    offset += heights[first] ?? 0;
    first += 1;
  }

  let last = first;
  let drawn = offset;
  while (last < heights.length && drawn < bottom) {
    drawn += heights[last] ?? 0;
    last += 1;
  }

  const from = Math.max(0, first - overscan);
  const to = Math.min(heights.length, last + overscan);
  return {
    from,
    to,
    padTop: sum(heights, 0, from),
    padBottom: sum(heights, to, heights.length),
  };
}
