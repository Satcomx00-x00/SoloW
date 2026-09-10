import { describe, expect, it } from "bun:test";
import { COMPACT_ZOOM, FIT_VIEW } from "./workflow-canvas-zoom";

describe("the canvas's zoom levels", () => {
  it("never fits the pipeline below the zoom at which a Step card can be edited", () => {
    // A `+` re-fits the view; if that could land under the compact threshold, the card just
    // added would arrive without its fields. The floor and the threshold are one number.
    expect(FIT_VIEW.minZoom).toBeGreaterThanOrEqual(COMPACT_ZOOM);
    expect(FIT_VIEW.maxZoom).toBeGreaterThan(FIT_VIEW.minZoom);
  });
});
