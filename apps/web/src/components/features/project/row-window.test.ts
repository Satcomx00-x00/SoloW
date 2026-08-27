/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { ROW_OVERSCAN, windowOf } from "./row-window";

/**
 * The windowing arithmetic behind F23 NFR-1 / issue #126 AC-6.
 *
 * Two properties carry the whole feature, and they pull in opposite directions: at a thousand
 * items the window has to be small, and at any size **the sum of what is drawn and what is padded
 * has to equal the whole list**. A window that is off by one line scrolls a table that jitters; a
 * pad that is off by a pixel scrolls a table whose scrollbar lies about how much is left.
 */

const rows = (n: number, height = 37): number[] => Array.from({ length: n }, () => height);

/** What every window must be true of, whatever the scroll position. */
function total(heights: readonly number[], scrollTop: number, viewport: number): number {
  const w = windowOf(heights, scrollTop, viewport);
  const drawn = heights.slice(w.from, w.to).reduce((a, b) => a + b, 0);
  return w.padTop + drawn + w.padBottom;
}

describe("windowOf", () => {
  it("draws everything when nothing has been measured yet", () => {
    // The case that is not hypothetical: every render before the first layout pass, and every
    // render in a test. Drawing nothing there would flash an empty table on mount.
    expect(windowOf(rows(500), 0, 0)).toEqual({ from: 0, to: 500, padTop: 0, padBottom: 0 });
  });

  it("draws everything, with no spacers, for a list that already fits", () => {
    // A short project must be byte-for-byte the table that existed before windowing — spacers on
    // a twelve-row table are a bug waiting to be reported as one.
    expect(windowOf(rows(12), 0, 900)).toEqual({ from: 0, to: 12, padTop: 0, padBottom: 0 });
  });

  it("draws a screenful plus the overscan out of a thousand rows", () => {
    const heights = rows(1000);
    const w = windowOf(heights, 0, 740); // 20 rows of 37px

    expect(w.from).toBe(0);
    // 20 on screen, plus overscan below. The point of the assertion is the order of magnitude:
    // tens of rows in the DOM, not a thousand.
    expect(w.to).toBe(20 + ROW_OVERSCAN);
    expect(w.to - w.from).toBeLessThan(50);
  });

  it("keeps the drawn lines and the two spacers adding up to the whole list", () => {
    const heights = rows(1000);
    const whole = 1000 * 37;

    for (const scrollTop of [0, 37, 1000, 18_500, whole - 740, whole * 2]) {
      expect(total(heights, scrollTop, 740)).toBe(whole);
    }
  });

  it("walks mixed heights rather than dividing by one of them", () => {
    // A grouped project interleaves 44px headings with 37px rows, so there is no single row
    // height to divide by — the reason this is a walk and not an arithmetic shortcut.
    const heights = [44, 37, 37, 37, 44, 37, 37];
    const w = windowOf(heights, 100, 40, 0);

    // 100px in is inside the third line (44 + 37 = 81, + 37 = 118), and 40px covers into the
    // fourth (118 + 37 = 155).
    expect(w.from).toBe(2);
    expect(w.to).toBe(4);
    expect(w.padTop).toBe(81);
    expect(w.padBottom).toBe(44 + 37 + 37);
  });

  it("scrolls into the middle without drawing what is above it", () => {
    const w = windowOf(rows(1000), 18_500, 740, 0);

    expect(w.from).toBe(500);
    expect(w.padTop).toBe(500 * 37);
    expect(w.padBottom).toBe((1000 - w.to) * 37);
  });

  it("survives a scroll position past the end and a negative one", () => {
    // Both happen: rubber-band scrolling overshoots, and a list that shrank under a filter leaves
    // the container scrolled past its own new height until the browser corrects it.
    const past = windowOf(rows(50), 1_000_000, 740);
    expect(past.from).toBeLessThanOrEqual(50);
    expect(past.to).toBe(50);
    expect(total(rows(50), 1_000_000, 740)).toBe(50 * 37);

    expect(total(rows(50), -200, 740)).toBe(50 * 37);
  });

  it("answers for an empty list without pretending there is a line in it", () => {
    expect(windowOf([], 0, 740)).toEqual({ from: 0, to: 0, padTop: 0, padBottom: 0 });
  });
});
