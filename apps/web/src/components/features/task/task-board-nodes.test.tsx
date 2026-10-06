/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { DecisionWidget } from "@solow/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { DecisionsNode, GateNode, TodoNode } from "./task-board-nodes";

/**
 * The board's cards: what each says, and which of them move. Motion is how the board points at
 * the card being worked on (blue) and the cards waiting on you (amber); every other card is still,
 * so a card that pulses without cause is noise the eye cannot tell from a real signal.
 */

const decision = (id: string): DecisionWidget =>
  ({
    kind: "decision",
    id,
    question: `What about ${id}?`,
    options: [
      { id: "a", label: "Option A" },
      { id: "b", label: "Option B" },
    ],
    chosen: "a",
  }) as DecisionWidget;

const card = (kind: string) =>
  document.querySelector(`[data-board-kind="${kind}"]`) as HTMLButtonElement;

afterEach(cleanup);

describe("GateNode", () => {
  it("pulses amber while it waits on you, and opens on click", () => {
    let opened = 0;
    render(
      <GateNode
        title="Review · Specify"
        headline="Your decision is needed"
        detail="2 changed files"
        attention
        onOpen={() => opened++}
      />,
    );

    expect(card("gate").className).toContain("board-pulse-waiting");
    expect(card("gate").className).not.toContain("board-pulse-running");
    fireEvent.click(card("gate"));
    expect(opened).toBe(1);
  });

  it("is still when nothing is asked of you", () => {
    render(
      <GateNode title="Review" headline="Approved" detail="" attention={false} onOpen={() => {}} />,
    );

    expect(card("gate").className).not.toContain("board-pulse");
  });
});

describe("TodoNode", () => {
  const items = [
    { content: "Write the spec", activeForm: "Writing the spec", status: "in_progress" },
    { content: "Write the checklist", status: "pending" },
  ] as never;

  it("pulses blue while the harness is working through it", () => {
    render(<TodoNode items={items} live onOpen={() => {}} />);

    expect(card("todos").className).toContain("board-pulse-running");
    expect(card("todos").textContent).toContain("Writing the spec");
  });

  it("is still once its Step is no longer running", () => {
    render(<TodoNode items={items} live={false} onOpen={() => {}} />);

    expect(card("todos").className).not.toContain("board-pulse");
  });
});

describe("DecisionsNode", () => {
  it("asks for confirmation, and pulses, while any decision is unsettled at the gate", () => {
    render(
      <DecisionsNode
        widgets={[decision("one"), decision("two")]}
        answers={[{ id: "one", choice: "a" }]}
        confirming
        onOpen={() => {}}
      />,
    );

    const node = card("decisions");
    expect(node.textContent).toContain("Confirm AI decisions");
    expect(node.textContent).toContain("1/2");
    expect(node.className).toContain("board-pulse-waiting");
  });

  it("reads as confirmed, and stops pulsing, once every decision is settled", () => {
    render(
      <DecisionsNode
        widgets={[decision("one")]}
        answers={[{ id: "one", choice: "a" }]}
        confirming
        onOpen={() => {}}
      />,
    );

    const node = card("decisions");
    expect(node.textContent).toContain("Confirmed");
    expect(node.className).not.toContain("board-pulse");
  });

  it("is a record, not a question, away from the gate it belongs to", () => {
    // A finished Step's decisions under a later Step's gate: `confirming` is false for them.
    render(
      <DecisionsNode
        widgets={[decision("one")]}
        answers={[]}
        confirming={false}
        onOpen={() => {}}
      />,
    );

    const node = card("decisions");
    expect(node.textContent).toContain("AI decided");
    expect(node.textContent).not.toContain("Confirm AI decisions");
    expect(node.className).not.toContain("board-pulse");
  });
});
