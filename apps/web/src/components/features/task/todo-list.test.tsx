/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { SessionEventDto, TodoItem } from "@solow/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { latestTodos, TodoList } from "./todo-list";

/**
 * The agent's plan, drawn as a checklist.
 *
 * Two properties matter enough to pin down. The first is that the three states are told apart
 * without hue: a reader who cannot see the green tick still has a different glyph and struck-out
 * text, which is what WCAG 1.4.1 asks of a distinction that carries meaning. The second is that
 * the list stays inert — a tickable box here would let a person record a claim about work only
 * the agent does, and it would be overwritten by the next `TodoWrite` regardless.
 *
 * `latestTodos` is tested for the property that makes it correct rather than for its shape: the
 * agent republishes the whole list every time, so the newest event has to win outright over the
 * ones behind it rather than being merged with them.
 */

afterEach(cleanup);

const todo = (over: Partial<TodoItem> = {}): TodoItem => ({
  content: "Write the failing test",
  status: "pending",
  ...over,
});

const sample: TodoItem[] = [
  { content: "Read the report", status: "completed" },
  { content: "Reproduce it", status: "completed" },
  { content: "Write the patch", status: "in_progress", activeForm: "Writing the patch" },
  { content: "Run the suite", status: "pending" },
];

/** The row for an item, found by the status attribute the component tags each row with. */
const rowFor = (container: HTMLElement, status: TodoItem["status"]) =>
  container.querySelector(`[data-todo-status="${status}"]`) as HTMLElement;

const iconIn = (row: HTMLElement) => row.querySelector("svg") as SVGElement;

describe("TodoList", () => {
  it("gives each state its own glyph, so the distinction survives without colour", () => {
    const { container } = render(<TodoList items={sample} />);

    // Three different shapes: an empty box, a spinner, a ticked box. Nobody has to see a hue.
    expect(iconIn(rowFor(container, "pending")).classList.contains("lucide-square")).toBe(true);
    expect(
      iconIn(rowFor(container, "in_progress")).classList.contains("lucide-loader-circle"),
    ).toBe(true);
    expect(
      iconIn(rowFor(container, "completed")).classList.contains("lucide-square-check-big"),
    ).toBe(true);

    // …and the finished item is struck through as well, so the difference is legible even at a
    // glance with the glyph column scrolled out of view.
    expect(rowFor(container, "completed").textContent).toContain("Read the report");
    expect(
      (rowFor(container, "completed").querySelector("td:last-child") as HTMLElement).className,
    ).toContain("line-through");
  });

  it("spins the live row with the shared class, which reduced motion already knows about", () => {
    // `animate-spin` would keep rotating for a reader who asked it not to; `.spinner` has the
    // `prefers-reduced-motion` carve-out in `globals.css`.
    const { container } = render(<TodoList items={sample} />);
    expect(iconIn(rowFor(container, "in_progress")).classList.contains("spinner")).toBe(true);
  });

  it("names the state in text, because the glyph is hidden from a screen reader", () => {
    render(<TodoList items={sample} />);

    expect(screen.getAllByText("Done:").length).toBe(2);
    expect(screen.getByText("In progress:")).toBeDefined();
    expect(screen.getByText("To do:")).toBeDefined();
  });

  it("shows the present-tense form for the item in progress, and falls back to the content", () => {
    const { container } = render(<TodoList items={sample} />);
    expect(rowFor(container, "in_progress").textContent).toContain("Writing the patch");

    cleanup();
    const bare = render(
      <TodoList items={[todo({ status: "in_progress", content: "Patching the latch" })]} />,
    );
    expect(rowFor(bare.container, "in_progress").textContent).toContain("Patching the latch");
  });

  it("says how far along the list is, which is what a checklist is read for", () => {
    render(<TodoList items={sample} />);
    expect(screen.getByText(/2 of 4 done/)).toBeDefined();
  });

  it("offers nothing to click, because the list is the agent's and not the reader's", () => {
    // A tickable box would be a lie twice over: the reader cannot do the work, and the next
    // `TodoWrite` would overwrite whatever they recorded.
    const { container } = render(<TodoList items={sample} />);

    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("button")).toBeNull();
    expect(screen.queryAllByRole("checkbox").length).toBe(0);
  });

  it("renders nothing at all when there are no items", () => {
    // The caller decides whether an absent list deserves a placeholder — only it knows whether
    // the run has started.
    const { container } = render(<TodoList items={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

const event = (seq: number, payload: SessionEventDto["payload"]): SessionEventDto => ({
  id: `evt-${seq}`,
  sessionId: "sess-1",
  seq,
  kind: payload.kind,
  payload,
  at: "2026-08-22T10:00:00.000Z",
});

describe("latestTodos", () => {
  it("takes the last list whole, because each rewrite supersedes the one before it", () => {
    const events = [
      event(1, { kind: "assistant_turn", text: "Planning.", thinking: false }),
      event(2, { kind: "todos", items: [todo({ content: "First plan" })] }),
      event(3, { kind: "tool_call", name: "Read", callId: "c1" }),
      event(4, {
        kind: "todos",
        items: [
          todo({ content: "First plan", status: "completed" }),
          todo({ content: "Second thoughts" }),
        ],
      }),
      event(5, { kind: "assistant_turn", text: "Done.", thinking: false }),
    ];

    const items = latestTodos(events);

    // Two items, not three: the earlier list is history, not something to merge in.
    expect(items.map((item) => item.content)).toEqual(["First plan", "Second thoughts"]);
  });

  it("returns an empty list when the session never published one", () => {
    expect(latestTodos([event(1, { kind: "notice", text: "started" })])).toEqual([]);
    expect(latestTodos([])).toEqual([]);
  });
});
