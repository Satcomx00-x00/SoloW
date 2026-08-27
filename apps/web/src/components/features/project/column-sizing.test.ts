/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "@solow/contracts";
import { clampWidth, moveColumn, orderColumns } from "./column-sizing";

describe("clampWidth", () => {
  it("refuses a width narrower than a header, which nobody could undo", () => {
    // Dragged to nothing, a column cannot show its own name — and the person who did it has no
    // way to find which one they broke.
    expect(clampWidth(2)).toBe(MIN_COLUMN_WIDTH);
  });

  it("refuses a width that would push every other column off screen", () => {
    expect(clampWidth(99_999)).toBe(MAX_COLUMN_WIDTH);
  });

  it("rounds, because the schema stores integers and a drag produces fractions", () => {
    expect(clampWidth(203.7)).toBe(204);
  });
});

describe("orderColumns", () => {
  const cols = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("puts the saved order first", () => {
    expect(orderColumns(cols, ["c", "a"]).map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps a column the saved order never named, behind the ones it did", () => {
    // A field added by a sync is not in an order saved last month. Dropping it would hide a real
    // column; putting it first would rearrange a table nobody touched.
    expect(orderColumns(cols, ["b"]).map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("ignores an id in the saved order that no longer exists", () => {
    expect(orderColumns(cols, ["gone", "b"]).map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("does not repeat a column named twice in the saved order", () => {
    expect(orderColumns(cols, ["a", "a"]).map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});

describe("moveColumn", () => {
  it("drops the dragged column where the target was", () => {
    expect(moveColumn(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveColumn(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("is a no-op when a column is dropped on itself", () => {
    expect(moveColumn(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });

  it("leaves the order alone for a drop on something that is not a column", () => {
    expect(moveColumn(["a", "b"], "a", "elsewhere")).toEqual(["a", "b"]);
  });

  it("returns the complete order, so a previously-unnamed column cannot jump later", () => {
    // The stored order has to name everything after a move: an unnamed column trails, and the
    // next render would move it without anyone asking.
    expect(moveColumn(["a", "b", "c"], "b", "a")).toHaveLength(3);
  });
});
