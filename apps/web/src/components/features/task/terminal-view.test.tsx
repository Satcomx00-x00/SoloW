/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalView } from "./terminal-view";
import type { TranscriptRow } from "./transcript";

/**
 * The terminal's two controls. What is worth holding onto is the behaviour an operator would
 * notice if it broke: the toggle says which mode it is in and can be flipped, and the find bar
 * counts, walks and closes the way an editor's does.
 *
 * Scrolling itself is not asserted here — happy-dom lays nothing out, so every element is zero
 * pixels tall and "is it at the bottom" has no meaning. The scroll rules live in the component
 * where they can be seen; what these cover is everything around them.
 */

const rows: TranscriptRow[] = [
  {
    kind: "text",
    id: "1",
    sessionId: "s",
    seq: 1,
    channel: "assistant",
    text: "Running pip to check versions",
    open: false,
  },
  {
    kind: "text",
    id: "2",
    sessionId: "s",
    seq: 2,
    channel: "user",
    text: "use pip, not poetry",
    open: false,
  },
];

function renderTerminal(over: Partial<React.ComponentProps<typeof TerminalView>> = {}) {
  return render(<TerminalView rows={rows} elided={0} onRespondPermission={() => {}} {...over} />);
}

afterEach(cleanup);

describe("auto-scroll toggle", () => {
  it("follows by default, and its state is on the control rather than in its label", () => {
    renderTerminal();
    // `aria-pressed`, not the text: the label stays "Auto-scroll" so that reading the button
    // tells you what it controls, not what it is currently doing.
    expect(
      screen.getByRole("button", { name: "Auto-scroll on" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("turns off and back on from the same control", () => {
    renderTerminal();
    fireEvent.click(screen.getByRole("button", { name: "Auto-scroll on" }));
    const off = screen.getByRole("button", { name: "Auto-scroll off" });
    expect(off.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(off);
    expect(
      screen.getByRole("button", { name: "Auto-scroll on" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("offers a way back to the tail only while it is not following", () => {
    renderTerminal();
    // Nothing to offer while it is already there.
    expect(screen.queryByRole("button", { name: /Jump to latest/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Auto-scroll on" }));
    fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
    expect(screen.getByRole("button", { name: "Auto-scroll on" })).toBeTruthy();
  });
});

describe("find bar", () => {
  it("opens from the toolbar and counts what it finds", () => {
    renderTerminal();
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));

    const box = screen.getByLabelText("Find in terminal");
    fireEvent.change(box, { target: { value: "pip" } });
    // Two rows mention pip; the count is of occurrences, and it starts on the first.
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });

  it("walks the matches with the buttons, wrapping at the end", () => {
    renderTerminal();
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));
    fireEvent.change(screen.getByLabelText("Find in terminal"), { target: { value: "pip" } });

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  it("walks them from the keyboard too", () => {
    renderTerminal();
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));
    const box = screen.getByLabelText("Find in terminal");
    fireEvent.change(box, { target: { value: "pip" } });

    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByText("2 of 2")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(screen.getByText("1 of 2")).toBeTruthy();
  });

  it("says so rather than showing a count of zero", () => {
    renderTerminal();
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));
    fireEvent.change(screen.getByLabelText("Find in terminal"), { target: { value: "zzz" } });
    expect(screen.getByText("no results")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next match" }).hasAttribute("disabled")).toBe(true);
  });

  it("marks the matches, and the active one apart from the rest", () => {
    const { container } = renderTerminal();
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));
    fireEvent.change(screen.getByLabelText("Find in terminal"), { target: { value: "pip" } });

    expect(container.querySelectorAll("mark")).toHaveLength(2);
    // Exactly one active marker: it is what the viewport scrolls to, so two would be a bug you
    // would only notice as the terminal jumping to the wrong place.
    expect(container.querySelectorAll("[data-match-active='true']")).toHaveLength(1);
  });

  it("closes on Escape, leaving no highlights behind", () => {
    const { container } = renderTerminal();
    fireEvent.click(screen.getByRole("button", { name: /Find/ }));
    const box = screen.getByLabelText("Find in terminal");
    fireEvent.change(box, { target: { value: "pip" } });
    fireEvent.keyDown(box, { key: "Escape" });

    expect(screen.queryByLabelText("Find in terminal")).toBeNull();
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("opens on the editor's own shortcut", () => {
    renderTerminal();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByLabelText("Find in terminal")).toBeTruthy();
  });
});

/**
 * Saying that the run is alive.
 *
 * The panel's silence used to be ambiguous: an agent thinking for a minute, an agent inside a
 * long `Bash` call and an agent that had hung all drew the same settled transcript. These pin the
 * line that separates them — and pin that it is absent when there is nothing to report, which is
 * the half that keeps it from becoming decoration under every finished run.
 */
describe("agent activity", () => {
  it("says the agent is launching over the empty terminal of a running task", () => {
    renderTerminal({ rows: [], isRunning: true });
    expect(screen.getByText(/Launching the agent/)).toBeTruthy();
    // And specifically no longer tells the operator to do the thing they have just done.
    expect(screen.queryByText(/Launch the task to start a run/)).toBeNull();
  });

  it("invites a launch when the empty terminal belongs to a task that is not running", () => {
    renderTerminal({ rows: [] });
    expect(screen.getByText(/Launch the task to start a run/)).toBeTruthy();
  });

  it("names what the agent is doing under a transcript that has stopped growing", () => {
    const { container } = renderTerminal({ isRunning: true });
    expect(container.querySelector("[data-agent-activity='thinking']")).toBeTruthy();
    expect(screen.getByText("Thinking…")).toBeTruthy();
  });

  it("leaves a finished run alone", () => {
    const { container } = renderTerminal();
    expect(container.querySelector("[data-agent-activity]")).toBeNull();
  });
});
