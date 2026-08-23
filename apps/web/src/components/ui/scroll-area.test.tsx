/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ScrollArea } from "./scroll-area";

/**
 * Regression guard for a real layout bug: Radix wraps `ScrollArea`'s children in its own
 * `<div style="min-width:100%;display:table">`. A table sizes to the widest *unbroken* line of
 * its content (shrink-to-fit) rather than to the Viewport's own width, so a long line inside —
 * a file path, a shell command — grows that wrapper past the visible panel. `overflow-x: hidden`
 * on the Viewport keeps the overflow from being reachable, but nothing then makes an inner
 * `truncate` fire, so a summary line meant to end in an ellipsis renders past the panel edge
 * instead (reported: the task terminal's tool-call rows spilling out of the split-pane column).
 *
 * happy-dom runs no layout engine and no Tailwind build, so the actual clipped width cannot be
 * asserted here — that was verified against the running app instead. What this guards is the
 * fix itself staying in place: the override class that forces Radix's wrapper back to
 * `display: block`, which is what lets `truncate`/`min-w-0` inside the content work at all.
 */

afterEach(cleanup);

describe("ScrollArea", () => {
  it("forces Radix's internal table-display wrapper back to block", () => {
    const { container } = render(
      <ScrollArea>
        <p>content</p>
      </ScrollArea>,
    );
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport?.className).toContain("[&>div]:block!");
  });
});
