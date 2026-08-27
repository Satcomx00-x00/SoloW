/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { SessionEventPayload, SessionSummaryDto } from "@solow/contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SessionLog } from "./session-log";

/**
 * The Conversation rendered as what it is (issue #2). These assert the two things the old
 * `eventText()` could not do: tell one kind of turn from another, and stand a summary in for a
 * range without losing the events underneath it.
 */

afterEach(cleanup);

const event = (seq: number, payload: SessionEventPayload) => ({
  id: `ev-${seq}`,
  sessionId: "sess-1",
  seq,
  kind: payload.kind,
  payload,
  at: "2026-01-01T00:00:00.000Z",
});

const summary = (over: Partial<SessionSummaryDto> = {}): SessionSummaryDto => ({
  id: "sum-1",
  sessionId: "sess-1",
  fromSeq: 0,
  toSeq: 1,
  eventCount: 2,
  text: "2 events — 2 assistant turns",
  at: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("SessionLog", () => {
  it("tells a user turn from an assistant turn", () => {
    render(
      <SessionLog
        events={[
          event(0, { kind: "user_turn", text: "fix the latch" }),
          event(1, { kind: "assistant_turn", text: "patched latch.ts", thinking: false }),
        ]}
        summaries={[]}
      />,
    );

    const mine = screen.getByText("fix the latch").closest("li");
    const theirs = screen.getByText("patched latch.ts").closest("li");
    expect(mine?.getAttribute("data-event-kind")).toBe("user_turn");
    expect(theirs?.getAttribute("data-event-kind")).toBe("assistant_turn");
    expect(within(mine as HTMLElement).getByText("You")).toBeDefined();
    expect(within(theirs as HTMLElement).getByText("Agent")).toBeDefined();
  });

  it("shows a tool call as the tool that ran, not as a line of text", () => {
    render(
      <SessionLog
        events={[event(0, { kind: "tool_call", name: "Edit", callId: "c1" })]}
        summaries={[]}
      />,
    );
    expect(screen.getByText("Edit")).toBeDefined();
    // Nothing produces tool input yet, and the render says so rather than showing an empty box.
    expect(screen.getByText("No input recorded.")).toBeDefined();
  });

  it("says where the plan stood, rather than rendering a blank row for it", () => {
    // A kind with no case in the body switch renders as nothing at all, and the type checker
    // cannot see it: the row keeps its gutter label and loses its content. `todos` reached this
    // view that way — the log holding the agent's whole plan while the tab whose job is to show
    // the log said nothing about it, which is the contentless row the capture existed to remove.
    render(
      <SessionLog
        events={[
          event(0, {
            kind: "todos",
            items: [
              { content: "Read the failing test", status: "completed" },
              { content: "Write the patch", status: "in_progress", activeForm: "Writing the fix" },
              { content: "Run the suite", status: "pending" },
            ],
          }),
        ]}
        summaries={[]}
      />,
    );

    expect(screen.getByText(/1 of 3 done/)).toBeDefined();
    expect(screen.getByText(/Writing the fix/)).toBeDefined();
  });

  it("renders a permission and its answer as themselves", () => {
    render(
      <SessionLog
        events={[
          event(0, {
            kind: "permission_request",
            requestId: "req-1",
            title: "Write .env",
            toolKind: "edit",
            options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
          }),
          event(1, {
            kind: "permission_resolved",
            requestId: "req-1",
            optionId: "allow",
            decidedBy: "operator",
          }),
        ]}
        summaries={[]}
      />,
    );
    expect(screen.getByText(/asked to Write \.env — Allow once/)).toBeDefined();
    expect(screen.getByText(/allow \(operator\)/)).toBeDefined();
  });

  it("stands a summary in for its range without mounting the events it covers", () => {
    // The reduction compaction is for: a collapsed range costs the workspace one row, not the
    // few hundred it stands in for. The tail is untouched — that is what the operator is reading.
    const events = [event(2, { kind: "assistant_turn", text: "line 2", thinking: false })];
    render(<SessionLog events={events} summaries={[summary()]} />);

    expect(screen.getByText(/2 events summarised/)).toBeDefined();
    expect(screen.getByText("line 2")).toBeDefined();
    expect(screen.queryByText("line 0")).toBeNull();
    expect(screen.queryByText("line 1")).toBeNull();
  });

  it("reads the range back when an operator expands it, because the events are still there", async () => {
    // The user-visible half of "compaction never deletes" (AC-2). The response does not carry
    // these events; the row fetches them, and only when someone asks.
    const asked: SessionSummaryDto[] = [];
    const loadRange = async (s: SessionSummaryDto) => {
      asked.push(s);
      return [
        event(0, { kind: "assistant_turn", text: "line 0", thinking: false }),
        event(1, { kind: "assistant_turn", text: "line 1", thinking: false }),
      ];
    };
    render(
      <SessionLog
        events={[event(2, { kind: "assistant_turn", text: "line 2", thinking: false })]}
        summaries={[summary()]}
        loadRange={loadRange}
      />,
    );

    // Nothing is fetched while the row is closed.
    expect(asked).toHaveLength(0);

    const toggle = screen.getByRole("button", { name: /2 events summarised/ });
    await act(async () => {
      fireEvent.click(toggle);
    });

    expect(asked).toEqual([summary()]);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("line 0")).toBeDefined();
    expect(screen.getByText("line 1")).toBeDefined();

    // …and collapsing puts them away again.
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.queryByText("line 0")).toBeNull();
  });

  it("expands from the events it was given when no reader was supplied", () => {
    // A Session nothing has compacted, or a caller that already holds the whole log: the range
    // still opens, without a round trip.
    const events = [
      event(0, { kind: "assistant_turn", text: "line 0", thinking: false }),
      event(1, { kind: "assistant_turn", text: "line 1", thinking: false }),
      event(2, { kind: "assistant_turn", text: "line 2", thinking: false }),
    ];
    render(<SessionLog events={events} summaries={[summary()]} />);

    fireEvent.click(screen.getByRole("button", { name: /2 events summarised/ }));
    expect(screen.getByText("line 0")).toBeDefined();
    expect(screen.getByText("line 1")).toBeDefined();
  });

  it("says so when a Session has only summarised ranges left to show", () => {
    render(<SessionLog events={[]} summaries={[summary()]} />);
    expect(screen.getByText(/2 events summarised/)).toBeDefined();
  });

  it("says so when a Session has recorded nothing yet", () => {
    render(<SessionLog events={[]} summaries={[]} />);
    expect(screen.getByText("No conversation yet.")).toBeDefined();
  });
});
