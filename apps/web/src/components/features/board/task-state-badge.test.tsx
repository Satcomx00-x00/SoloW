/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskState } from "@solow/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { BOARD_COLUMNS, STATE_LABELS, STATE_STYLE } from "@/lib/task-states";
import { TaskStateBadge } from "./task-state-badge";

/**
 * Lifecycle state presentation (task TASK-021).
 *
 * These exist because the states used to be mapped onto shadcn's four generic badge variants,
 * which silently collapsed three pairs into identical pills: Running looked like Review, Ready
 * like Done, Backlog like Parked. On a board whose whole job is to say which Tasks need a human,
 * that is a defect, and it is the kind that creeps back the next time someone adds a state.
 */

afterEach(cleanup);

const badgeFor = (state: TaskState): HTMLElement => {
  cleanup();
  render(<TaskStateBadge state={state} />);
  return screen.getByText(STATE_LABELS[state]).closest("[data-task-state]") as HTMLElement;
};

describe("TaskStateBadge", () => {
  it("gives every lifecycle state its own appearance", () => {
    const tones = BOARD_COLUMNS.map((state) => STATE_STYLE[state].badgeClassName);
    // The original bug in one assertion: seven states, seven distinct treatments.
    expect(new Set(tones).size).toBe(BOARD_COLUMNS.length);
  });

  it("distinguishes the pairs that used to render identically", () => {
    for (const [a, b] of [
      ["running", "review"],
      ["ready", "done"],
      ["backlog", "parked"],
    ] as Array<[TaskState, TaskState]>) {
      expect(STATE_STYLE[a].badgeClassName).not.toBe(STATE_STYLE[b].badgeClassName);
      expect(STATE_STYLE[a].icon).not.toBe(STATE_STYLE[b].icon);
    }
  });

  it("never relies on colour alone to carry the state", () => {
    // A colour-blind reader has to be able to tell Failed from Done (WCAG 1.4.1), so each state
    // also has its own glyph and its own written label.
    const icons = BOARD_COLUMNS.map((state) => STATE_STYLE[state].icon);
    expect(new Set(icons).size).toBe(BOARD_COLUMNS.length);

    for (const state of BOARD_COLUMNS) {
      const badge = badgeFor(state);
      expect(badge.querySelector("svg")).not.toBeNull();
      expect(badge.textContent).toContain(STATE_LABELS[state]);
    }
  });

  it("keeps the state readable when it shows a count instead of a label", () => {
    // Column headers and the lifecycle navigator show counts; the state must still be announced.
    render(<TaskStateBadge state="review" count={3} />);
    const badge = screen.getByText("3").closest("[data-task-state]") as HTMLElement;
    expect(badge.getAttribute("data-task-state")).toBe("review");
    expect(badge.textContent).toContain("Review");
  });

  it("keeps the hook the E2E suite reads a Task's state through", () => {
    expect(badgeFor("done").getAttribute("data-task-state")).toBe("done");
  });

  it("spins only while an agent is actually working", () => {
    // A permanent spinner on a finished Task would report work that is not happening.
    expect(badgeFor("running").querySelector("svg")?.getAttribute("class")).toContain(
      "spinner-ambient",
    );
    for (const idle of ["review", "parked", "failed", "done"] as TaskState[]) {
      expect(badgeFor(idle).querySelector("svg")?.getAttribute("class")).not.toContain("spinner");
    }
  });

  it("explains what each state means, for the states whose name is not self-evident", () => {
    // "Parked" and "Review" are the two a new operator cannot guess from the word alone.
    expect(badgeFor("parked").getAttribute("title")).toContain("resumes automatically");
    expect(badgeFor("review").getAttribute("title")).toContain("Waiting for your review");
  });
});
