/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { windowFor } from "./use-virtual-rows";

/**
 * The windowing arithmetic (issue #126, F23 NFR-1), tested as the pure function it is.
 *
 * The failures worth catching are all off-by-one: a window that starts one row late shows a
 * blank band at the top of every scroll, and padding that does not match the rows removed makes
 * the scrollbar lie about the length of the list.
 */
describe("windowFor", () => {
  it("renders only what fits, plus a margin on each side", () => {
    const w = windowFor(0, 300, 30, 1000);

    expect(w.start).toBe(0);
    // 10 rows fit, plus 3 of overscan on each side.
    expect(w.end).toBe(16);
  });

  it("pads exactly what it skipped, so the scrollbar tells the truth", () => {
    const w = windowFor(3000, 300, 30, 1000);

    expect(w.paddingTop).toBe(w.start * 30);
    expect(w.paddingBottom).toBe((1000 - w.end) * 30);
    // The two spacers plus the rendered rows are the full list.
    expect(w.paddingTop + (w.end - w.start) * 30 + w.paddingBottom).toBe(1000 * 30);
  });

  it("never starts before the first row", () => {
    // Scrolled to the top, the overscan would otherwise index backwards.
    expect(windowFor(0, 300, 30, 1000).start).toBe(0);
    expect(windowFor(10, 300, 30, 1000).start).toBe(0);
  });

  it("never runs past the last row", () => {
    const w = windowFor(30_000, 300, 30, 1000);

    expect(w.end).toBe(1000);
    expect(w.paddingBottom).toBe(0);
  });

  it("renders everything for a list shorter than the viewport", () => {
    const w = windowFor(0, 800, 30, 5);

    expect(w).toEqual({ start: 0, end: 5, paddingTop: 0, paddingBottom: 0 });
  });

  it("renders everything rather than nothing when it has not been measured", () => {
    // A table that renders nothing until an effect runs flashes blank on every navigation.
    expect(windowFor(0, 0, 30, 40)).toMatchObject({ start: 0, end: 40 });
    expect(windowFor(0, 300, 0, 40)).toMatchObject({ start: 0, end: 40 });
  });

  it("handles an empty list without producing a negative window", () => {
    expect(windowFor(0, 300, 30, 0)).toEqual({ start: 0, end: 0, paddingTop: 0, paddingBottom: 0 });
  });
});
