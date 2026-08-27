/**
 * The arithmetic behind the date cell, with no DOM and no `Date.now()` in sight.
 *
 * Every function here takes the day it should treat as "today" rather than reading a clock, which
 * is what makes "next friday" a thing that can be tested rather than a thing that can only be
 * watched. It is also the only way a test of `+2w` is stable in January and in July.
 *
 * **Everything is UTC.** A project's dates are plain calendar days — `2026-09-01` is the first of
 * September wherever the reader is sitting — and running them through a local-time `Date` moves
 * half of them by one day for anybody west of Greenwich. Parsing `new Date("2026-09-01")` gives
 * midnight UTC and printing it with `getDate()` gives the 31st of August in New York, which is the
 * bug this file exists to not have.
 */

/** `YYYY-MM-DD`, the only form anything here stores or returns. */
const ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * The weekday column headings, Monday first: this is a planning table, and a planning week starts
 * when work does.
 *
 * Each carries its own name as well as its initial, because the initials repeat — T and T, S and S
 * — so the initial cannot identify a column, and a heading needs a name a screen reader can say.
 */
export const WEEKDAY_HEADINGS = WEEKDAYS.map((name) => ({
  name,
  initial: name.charAt(0).toUpperCase(),
}));

function toUtc(iso: string): Date | null {
  const parts = ISO.exec(iso.trim());
  if (!parts) return null;
  const [, y, m, d] = parts;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects the 31st of February rather than silently rolling it into March, which is what the
  // Date constructor does and what would make a typo look like an accepted value.
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

const fromUtc = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Today, as a calendar day.
 *
 * The **local** day, not the UTC one, and that is deliberate: everything else here is UTC because
 * a project's dates are timezone-free calendar days, but "today" is the day the person at the
 * keyboard is living in. Taking the UTC date would tell somebody in Auckland it is still
 * yesterday for most of their working morning.
 */
export function isoToday(now: Date): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Is this a date this module will accept at all? */
export function isIsoDate(value: string): boolean {
  return toUtc(value) !== null;
}

/** The same day, `days` later. Negative goes back. */
export function addDays(iso: string, days: number): string {
  const date = toUtc(iso);
  if (!date) return iso;
  date.setUTCDate(date.getUTCDate() + days);
  return fromUtc(date);
}

/**
 * The same day-of-month, `months` later — clamped to the end of a month that is too short.
 *
 * The 31st of January plus one month is the 28th of February, not the 3rd of March. Rolling over
 * is what the platform does by default and it is never what a person meant by "in a month".
 */
export function addMonths(iso: string, months: number): string {
  const date = toUtc(iso);
  if (!date) return iso;
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastOfMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastOfMonth));
  return fromUtc(date);
}

/** The last day of the month this date is in. */
export function endOfMonth(iso: string): string {
  const date = toUtc(iso);
  if (!date) return iso;
  return fromUtc(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
}

/** The month a date is in, as the picker addresses one: `YYYY-MM`. */
export function monthOf(iso: string): string {
  return isIsoDate(iso) ? iso.slice(0, 7) : "";
}

/** "September 2026", for the calendar's own heading. */
export function monthLabel(month: string): string {
  const first = toUtc(`${month}-01`);
  if (!first) return month;
  return `${MONTH_NAMES[first.getUTCMonth()]} ${first.getUTCFullYear()}`;
}

/** How a date reads in a cell: short, unambiguous, and not the ISO string. */
export function formatDate(iso: string): string {
  const date = toUtc(iso);
  if (!date) return iso;
  const month = MONTH_NAMES[date.getUTCMonth()]?.slice(0, 3) ?? "";
  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}`;
}

/**
 * Six weeks of days, Monday-first, covering the month and spilling into its neighbours.
 *
 * Always 42 cells, never 35: a popover that grows a row when you page from September into November
 * moves the buttons under the cursor, and a calendar that changes height is a calendar people
 * misclick.
 */
export function monthGrid(month: string): string[][] {
  const first = toUtc(`${month}-01`);
  if (!first) return [];
  // `getUTCDay()` is Sunday-based; this shifts it so Monday is 0.
  const lead = (first.getUTCDay() + 6) % 7;
  const start = addDays(fromUtc(first), -lead);
  const weeks: string[][] = [];
  for (let week = 0; week < 6; week += 1) {
    weeks.push(Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day)));
  }
  return weeks;
}

/**
 * What somebody typed, as a date — or null, which reverts the cell.
 *
 * The accepted forms, and the reasoning behind each:
 *
 *  - `2026-09-01` — what the provider stores, so a value can be pasted straight back in.
 *  - `today`, `tomorrow`, `yesterday` — the three days anybody types by name.
 *  - `+7`, `+2w`, `-3d`, `+1m` — offsets, because "two weeks out" is how planning is spoken.
 *  - `friday`, `next friday` — the next one of those, never today itself even if today is a
 *    Friday: somebody typing a weekday name on a Friday means the one coming, not the one they
 *    are standing in.
 *
 * And the one deliberately refused: `01/09/2026`. It is the 1st of September to most of the world
 * and the 9th of January in the United States, and there is no way to tell which was meant. A
 * planning tool that guesses gets it right most of the time, which is the worst possible outcome.
 */
export function parseDateInput(text: string, today: string): string | null {
  const input = text.trim().toLowerCase();
  if (input === "") return null;

  if (isIsoDate(input)) {
    // Normalised, so `2026-9-1` is stored the way everything else spells it.
    const date = toUtc(input);
    return date ? fromUtc(date) : null;
  }
  if (!isIsoDate(today)) return null;

  if (input === "today") return today;
  if (input === "tomorrow") return addDays(today, 1);
  if (input === "yesterday") return addDays(today, -1);
  if (input === "eom" || input === "end of month") return endOfMonth(today);

  const offset = /^([+-])\s*(\d{1,4})\s*(d|w|m)?$/.exec(input);
  if (offset) {
    const sign = offset[1] === "-" ? -1 : 1;
    const amount = Number(offset[2]) * sign;
    switch (offset[3]) {
      case "w":
        return addDays(today, amount * 7);
      case "m":
        return addMonths(today, amount);
      default:
        return addDays(today, amount);
    }
  }

  const weekday = WEEKDAYS.indexOf(input.replace(/^next\s+/, "") as (typeof WEEKDAYS)[number]);
  if (weekday >= 0) {
    const from = toUtc(today);
    if (!from) return null;
    const current = (from.getUTCDay() + 6) % 7;
    // `|| 7` is what makes "the next one", not "today": a zero-day step would resolve a weekday
    // name to the day the operator is already looking at.
    return addDays(today, (weekday - current + 7) % 7 || 7);
  }

  return null;
}

/**
 * How long a span is, in the unit a person would say it in.
 *
 * Null when the two dates are not both real, and **negative spans are described rather than
 * hidden**: a target before its start is a mistake somebody needs to see stated, not a blank.
 */
export function describeSpan(from: string, to: string): string | null {
  const start = toUtc(from);
  const end = toUtc(to);
  if (!start || !end) return null;
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (days < 0) return `${describeSpan(to, from)} earlier`;
  if (days === 0) return "same day";
  if (days === 1) return "1 day";
  if (days < 14) return `${days} days`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  return `${Math.round(days / 30)} months`;
}
