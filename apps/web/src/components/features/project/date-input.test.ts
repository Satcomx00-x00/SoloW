/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
  addDays,
  addMonths,
  describeSpan,
  endOfMonth,
  formatDate,
  isIsoDate,
  monthGrid,
  monthLabel,
  parseDateInput,
  WEEKDAY_HEADINGS,
} from "./date-input";

/**
 * The date arithmetic a picker runs on.
 *
 * Two properties hold across the whole file. **Nothing reads a clock** — "today" is an argument,
 * which is what makes a relative date testable at all. And **every calculation is UTC**: a plain
 * calendar day run through a local-time `Date` moves by one for half the planet, and a planning
 * date that is off by a day is worse than one that is missing.
 */

/** A Wednesday, in a 30-day month, far from any boundary a bug could hide behind. */
const TODAY = "2026-09-16";

describe("isIsoDate", () => {
  it("accepts the form the provider stores", () => {
    expect(isIsoDate("2026-09-01")).toBe(true);
  });

  it("refuses a day that does not exist, rather than rolling it into next month", () => {
    // `new Date(Date.UTC(2026, 1, 31))` is the 3rd of March. Accepting that would turn a typo
    // into a date the operator never chose and cannot see is wrong.
    expect(isIsoDate("2026-02-31")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("not a date")).toBe(false);
  });
});

describe("addMonths", () => {
  it("clamps into a month too short to hold the day", () => {
    // "In a month" from the 31st of January is the end of February. Rolling over to the 3rd of
    // March is what the platform does and never what a person meant.
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });

  it("crosses a year boundary in both directions", () => {
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });
});

describe("addDays", () => {
  it("crosses a month and a year", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("crosses the end of February in a leap year", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("endOfMonth", () => {
  it("knows how long each month is, leap years included", () => {
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(endOfMonth("2026-09-01")).toBe("2026-09-30");
  });
});

describe("monthGrid", () => {
  it("always draws six weeks, so the popover cannot change height between months", () => {
    // A calendar that grows a row when you page forward moves the buttons under the cursor.
    for (const month of ["2026-02", "2026-09", "2026-11", "2027-05"]) {
      const grid = monthGrid(month);
      expect(grid).toHaveLength(6);
      expect(grid.every((week) => week.length === 7)).toBe(true);
    }
  });

  it("starts every week on a Monday", () => {
    const grid = monthGrid("2026-09");
    for (const week of grid) {
      const day = new Date(`${week[0]}T00:00:00Z`).getUTCDay();
      expect(day).toBe(1);
    }
  });

  it("contains every day of the month it was asked for", () => {
    const days = monthGrid("2026-02").flat();
    expect(days).toContain("2026-02-01");
    expect(days).toContain("2026-02-28");
    // February 2026 starts on a Sunday, so the grid leads in with six days of January.
    expect(days[0]).toBe("2026-01-26");
  });

  it("is empty for something that is not a month, rather than throwing inside a render", () => {
    expect(monthGrid("nonsense")).toEqual([]);
  });
});

describe("parseDateInput", () => {
  it("takes the stored form back, normalised", () => {
    expect(parseDateInput("2026-09-01", TODAY)).toBe("2026-09-01");
    expect(parseDateInput("2026-9-1", TODAY)).toBe("2026-09-01");
  });

  it("takes the three days people type by name", () => {
    expect(parseDateInput("today", TODAY)).toBe(TODAY);
    expect(parseDateInput("Tomorrow", TODAY)).toBe("2026-09-17");
    expect(parseDateInput("yesterday", TODAY)).toBe("2026-09-15");
  });

  it("takes offsets, because that is how planning is spoken", () => {
    expect(parseDateInput("+7", TODAY)).toBe("2026-09-23");
    expect(parseDateInput("+2w", TODAY)).toBe("2026-09-30");
    expect(parseDateInput("-3d", TODAY)).toBe("2026-09-13");
    expect(parseDateInput("+1m", TODAY)).toBe("2026-10-16");
  });

  it("resolves a weekday to the next one, never to today", () => {
    // Typing a weekday name on that very weekday means the one coming. A zero-day step would
    // resolve it to the day already on screen, which reads as the input having been ignored.
    expect(parseDateInput("friday", TODAY)).toBe("2026-09-18");
    expect(parseDateInput("next friday", TODAY)).toBe("2026-09-18");
    expect(parseDateInput("wednesday", TODAY)).toBe("2026-09-23");
  });

  it("refuses a slashed date, which is two different days depending on who typed it", () => {
    // 01/09/2026 is the 1st of September to most of the world and the 9th of January in the US.
    // Guessing would be right most of the time, which is the worst available outcome.
    expect(parseDateInput("01/09/2026", TODAY)).toBeNull();
  });

  it("refuses what it cannot read, rather than returning a plausible date", () => {
    expect(parseDateInput("sometime next quarter", TODAY)).toBeNull();
    expect(parseDateInput("", TODAY)).toBeNull();
    expect(parseDateInput("2026-02-31", TODAY)).toBeNull();
  });
});

describe("describeSpan", () => {
  it("says the span in the unit a person would use", () => {
    expect(describeSpan("2026-09-01", "2026-09-01")).toBe("same day");
    expect(describeSpan("2026-09-01", "2026-09-02")).toBe("1 day");
    expect(describeSpan("2026-09-01", "2026-09-08")).toBe("7 days");
    expect(describeSpan("2026-09-01", "2026-10-13")).toBe("6 weeks");
    expect(describeSpan("2026-09-01", "2027-03-01")).toBe("6 months");
  });

  it("states a backwards span instead of hiding it", () => {
    // A target before its start is a mistake somebody has to be shown, not a blank cell.
    expect(describeSpan("2026-09-10", "2026-09-03")).toBe("7 days earlier");
  });

  it("is null when either end is not a date", () => {
    expect(describeSpan("2026-09-01", "")).toBeNull();
  });
});

describe("formatDate and monthLabel", () => {
  it("spells a date the way a cell should read", () => {
    expect(formatDate("2026-09-01")).toBe("1 Sep 2026");
  });

  it("does not shift a day across a timezone", () => {
    // The regression this guards: `new Date("2026-01-01").getDate()` is the 31st of December in
    // any timezone west of Greenwich.
    expect(formatDate("2026-01-01")).toBe("1 Jan 2026");
  });

  it("names a month for its own heading", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
  });
});

describe("WEEKDAY_HEADINGS", () => {
  it("starts on Monday and names every column", () => {
    // The initials repeat — T/T and S/S — so a heading carries its full name too: it is what a
    // screen reader says and what identifies the column in a key.
    expect(WEEKDAY_HEADINGS.map((d) => d.initial)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    expect(WEEKDAY_HEADINGS[0]?.name).toBe("monday");
    expect(new Set(WEEKDAY_HEADINGS.map((d) => d.name)).size).toBe(7);
  });
});
