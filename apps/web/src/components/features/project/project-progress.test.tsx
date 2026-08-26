/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SubIssueProgress } from "./project-progress";

/**
 * The segmented sub-issue bar (GitHub Projects §4).
 *
 * The property worth holding: **one segment per sub-issue**, because that is the whole reason to
 * prefer it to a continuous fill. `3/4` and `75%` are the same number either way; four discrete
 * marks are what say "one thing is left" without arithmetic.
 */

afterEach(cleanup);

/** The segments are the leaf spans inside the track — the track itself is the only aria-hidden. */
function segments(container: HTMLElement): HTMLElement[] {
  const track = container.querySelector("[aria-hidden]");
  return [...(track?.children ?? [])] as HTMLElement[];
}

describe("SubIssueProgress", () => {
  it("draws one segment per sub-issue, not a continuous fill", () => {
    const { container } = render(<SubIssueProgress done={1} total={4} />);

    expect(segments(container)).toHaveLength(4);
  });

  it("marks exactly the done ones, leaving the rest visible but not counted", () => {
    // Dimmed rather than absent: the total has to stay legible, or the bar answers "how far
    // along" while hiding "out of how many".
    const { container } = render(<SubIssueProgress done={1} total={3} />);

    const opacities = segments(container).map((s) =>
      s.className.includes("opacity-100") ? "done" : "todo",
    );
    expect(opacities).toEqual(["done", "todo", "todo"]);
  });

  it("says the count and the percentage, which answer different questions", () => {
    render(<SubIssueProgress done={1} total={4} />);

    expect(screen.getByText("1/4")).toBeDefined();
    expect(screen.getByText("25%")).toBeDefined();
  });

  it("renders nothing at all for a row with no sub-issues", () => {
    // Not "0/0" and not "0%": a row with no children is not a row at zero percent.
    const { container } = render(<SubIssueProgress done={0} total={0} />);

    expect(container.textContent).toBe("");
  });

  it("falls back to one continuous fill past the point where segments stop reading", () => {
    // A segment needs a pixel or two to be a segment; past roughly two dozen the gaps eat the
    // bar. The count beside it still carries the exact answer, so nothing is lost.
    const { container } = render(<SubIssueProgress done={30} total={60} />);

    expect(segments(container)).toHaveLength(1);
    expect(screen.getByText("30/60")).toBeDefined();
    expect(screen.getByText("50%")).toBeDefined();
  });
});
