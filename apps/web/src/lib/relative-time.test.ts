/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { relativeAge } from "./relative-time";

/**
 * The boundaries, pinned — because every one of them is a place the label can quietly become
 * wrong rather than obviously broken. `now` is injected so this measures the function and not
 * the machine it runs on.
 */

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeAge", () => {
  it("says just now under a minute", () => {
    expect(relativeAge(ago(20 * SECOND), NOW)).toBe("just now");
  });

  it("counts minutes", () => {
    expect(relativeAge(ago(4 * MINUTE), NOW)).toBe("4m ago");
  });

  it("switches to hours at the hour", () => {
    expect(relativeAge(ago(59 * MINUTE), NOW)).toBe("59m ago");
    expect(relativeAge(ago(90 * MINUTE), NOW)).toBe("2h ago");
  });

  it("switches to days at the day", () => {
    expect(relativeAge(ago(23 * HOUR), NOW)).toBe("23h ago");
    expect(relativeAge(ago(3 * DAY), NOW)).toBe("3d ago");
  });

  it("gives up on relative past a fortnight, because 43d ago is a date nobody can place", () => {
    expect(relativeAge(ago(20 * DAY), NOW)).toBe(new Date(ago(20 * DAY)).toLocaleDateString());
  });

  it("answers empty on a timestamp it cannot read rather than rendering NaN", () => {
    expect(relativeAge("not a date", NOW)).toBe("");
  });
});
