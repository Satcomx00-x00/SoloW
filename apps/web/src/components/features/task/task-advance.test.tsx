/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskState } from "@solow/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskAdvance } from "./task-advance";

/**
 * Stepping a Task along the lifecycle from its own page.
 *
 * Two properties matter here and neither is cosmetic. The first is that the destination is
 * *named*: an icon-only chevron over a seven-state lifecycle tells a screen-reader user nothing,
 * so the assertions below go through `aria-label` rather than through the glyph — if the label
 * ever degrades to "Next", these tests stop finding the button. The second is that a direction
 * with no legal target stays on screen, disabled: a control that vanishes as a Task advances
 * shifts the surviving arrow under the cursor, and people stop trusting a control that moves.
 */

afterEach(cleanup);

const moved: TaskState[] = [];
const record = (to: TaskState) => {
  moved.push(to);
};

afterEach(() => {
  moved.length = 0;
});

describe("TaskAdvance", () => {
  it("offers both directions mid-lifecycle, naming each destination", () => {
    // A Task under review is the case the control exists for: approve it onward to Done, or send
    // it back to Running for another pass, without leaving the page holding the diff.
    render(<TaskAdvance state="review" onMove={record} />);

    const back = screen.getByLabelText("Move to Running");
    const forward = screen.getByLabelText("Move to Done");
    expect(back.hasAttribute("disabled")).toBe(false);
    expect(forward.hasAttribute("disabled")).toBe(false);
  });

  it("hands the callback the destination the button names", () => {
    render(<TaskAdvance state="ready" onMove={record} />);

    fireEvent.click(screen.getByLabelText("Move to Running"));
    fireEvent.click(screen.getByLabelText("Move to Backlog"));
    expect(moved).toEqual(["running", "backlog"]);
  });

  it("keeps a dead direction present but disabled, never hidden", () => {
    // `done` is terminal and `running` has no way back, so each has exactly one dead arrow.
    // Both render two buttons regardless — the arrows never change position under the cursor.
    render(<TaskAdvance state="done" onMove={record} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByLabelText("No state to move forward to").hasAttribute("disabled")).toBe(
      true,
    );

    cleanup();

    render(<TaskAdvance state="backlog" onMove={record} />);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByLabelText("No state to move back to").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Move to Ready").hasAttribute("disabled")).toBe(false);
  });

  it("does not offer to give up on a parked task", () => {
    // `failed` is the only state ahead of `parked` in column order, so a derived forward arrow
    // reads "Move to Failed" — the one thing a Task waiting out a quota window, which resumes by
    // itself, must not be one click away from.
    render(<TaskAdvance state="parked" onMove={record} />);

    expect(screen.getByLabelText("No state to move forward to").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("offers no direction at all while an agent is running", () => {
    // Both exits from Running belong to the run: it has nowhere to retreat to, and the state it
    // advances into is the one the orchestrator announces when the agent stops. Writing `review`
    // by hand opens the gate before the workflow is waiting on it, and the Approve pressed there
    // is published into nothing.
    render(<TaskAdvance state="running" onMove={record} />);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(screen.getByLabelText("No state to move back to").hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("No state to move forward to").hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("does not fire while a move is already in flight", () => {
    // The workspace owns the mutation, so a second click during `pending` would be a second
    // state change on the same Task — the exact double-submit the Button primitive guards.
    render(<TaskAdvance state="review" onMove={record} pending />);

    fireEvent.click(screen.getByLabelText("Move to Done"));
    expect(moved).toEqual([]);
  });
});
