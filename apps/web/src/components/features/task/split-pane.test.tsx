/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { TASK_PANE_MAX_WIDTH, TASK_PANE_MIN_WIDTH } from "@gatecontrol/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SplitPane } from "./split-pane";

/**
 * The Task page's split. What matters here is that the divider is usable without a pointer, that
 * a fold can always be undone, and that the caller is told the new width once per gesture rather
 * than once per mouse move — the last one is why the width is a server-side preference at all.
 */

afterEach(cleanup);

function renderPane(over: Partial<Parameters<typeof SplitPane>[0]> = {}) {
  const resizes: number[] = [];
  const toggles: boolean[] = [];
  render(
    <SplitPane
      collapsed={false}
      left={<p>terminal</p>}
      onResize={(w) => resizes.push(w)}
      onToggle={(c) => toggles.push(c)}
      right={<p>the diff</p>}
      rightLabel="Changes"
      width={420}
      {...over}
    />,
  );
  return { resizes, toggles };
}

describe("SplitPane", () => {
  it("shows both panes, with the right one named for assistive technology", () => {
    renderPane();
    expect(screen.getByText("terminal")).toBeDefined();
    expect(screen.getByRole("complementary", { name: "Changes" })).toBeDefined();
  });

  it("reports the divider's position, so the caller can persist it", () => {
    const { resizes } = renderPane();
    const divider = screen.getByRole("separator", { name: /Resize Changes/ });

    fireEvent.pointerDown(divider);
    fireEvent.pointerMove(window, { clientX: 100 });
    fireEvent.pointerUp(window);

    // Once, on release — not once per move. A drag that wrote per mouse move would be one
    // database round trip per frame.
    expect(resizes).toHaveLength(1);
  });

  it("can be resized from the keyboard, since a separator only usable by pointer is not usable", () => {
    const { resizes } = renderPane();
    const divider = screen.getByRole("separator", { name: /Resize Changes/ });

    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(resizes[0]).toBeGreaterThan(420);

    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(resizes[1]).toBeLessThan(420);
  });

  it("refuses to grow past the bounds the contract sets", () => {
    const { resizes } = renderPane({ width: TASK_PANE_MAX_WIDTH });
    fireEvent.keyDown(screen.getByRole("separator", { name: /Resize Changes/ }), {
      key: "ArrowLeft",
    });
    expect(resizes[0]).toBe(TASK_PANE_MAX_WIDTH);
  });

  it("refuses to shrink past the bounds, so the column stays grabbable", () => {
    const { resizes } = renderPane({ width: TASK_PANE_MIN_WIDTH });
    fireEvent.keyDown(screen.getByRole("separator", { name: /Resize Changes/ }), {
      key: "ArrowRight",
    });
    expect(resizes[0]).toBe(TASK_PANE_MIN_WIDTH);
  });

  it("folds away, and can always be brought back", () => {
    const { toggles } = renderPane();
    fireEvent.click(screen.getByRole("button", { name: "Hide Changes" }));
    expect(toggles).toEqual([true]);

    cleanup();
    const folded = renderPane({ collapsed: true });
    // A fold with no visible way out is how a panel gets lost for good.
    expect(screen.queryByRole("complementary", { name: "Changes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show Changes" }));
    expect(folded.toggles).toEqual([false]);
  });

  it("keeps the left pane mounted when the column is folded", () => {
    renderPane({ collapsed: true });
    expect(screen.getByText("terminal")).toBeDefined();
  });
});
