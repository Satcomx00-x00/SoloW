/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { SessionEventDto, TaskEvent, Widget } from "@gatecontrol/contracts";
import { WIDGET_ANSWER_PREFIX } from "@gatecontrol/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { buildTranscript } from "../transcript";
import { AskUserInput } from "./ask-user-input";
import { rendererFor } from "./registry";
import { ShowWidget } from "./show-widget";

/**
 * Agent widgets, on the client: the transcript has to fold a widget and its answer into one row,
 * and `show_widget` has to keep model-written markup out of the app's own document.
 */

const ASK: Widget = {
  kind: "ask_user_input",
  prompt: "Which database?",
  mode: "single",
  allowOther: false,
  options: [
    { id: "pg", label: "PostgreSQL" },
    { id: "sqlite", label: "SQLite" },
  ],
};

function persistedWidget(seq: number, widget: Widget = ASK): SessionEventDto {
  return {
    id: `e${seq}`,
    sessionId: "s-1",
    seq,
    kind: "widget",
    payload: { kind: "widget", widgetId: "w-1", widget },
    at: "2026-01-01T00:00:00.000Z",
  };
}

afterEach(cleanup);

describe("transcript widget rows", () => {
  it("makes a widget its own row", () => {
    const rows = buildTranscript([persistedWidget(0)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "widget", widgetId: "w-1", response: null });
  });

  it("folds the answer into the widget that asked, rather than adding a row", () => {
    const answer: SessionEventDto = {
      id: "e1",
      sessionId: "s-1",
      seq: 1,
      kind: "widget_response",
      payload: { kind: "widget_response", widgetId: "w-1", values: ["pg"], text: null },
      at: "2026-01-01T00:00:01.000Z",
    };

    const rows = buildTranscript([persistedWidget(0), answer], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "widget", response: { values: ["pg"], text: null } });
  });

  it("hides the machine's echo of an answer the card already shows", () => {
    const echo: SessionEventDto = {
      id: "e1",
      sessionId: "s-1",
      seq: 1,
      kind: "user_turn",
      payload: {
        kind: "user_turn",
        text: `${WIDGET_ANSWER_PREFIX} The operator answered "Which database?": SQLite (ids: sqlite)`,
      },
      at: "2026-01-01T00:00:01.000Z",
    };

    const rows = buildTranscript([persistedWidget(0), echo], []);
    // Just the widget: the answer is already on its card, in the operator's own words.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("widget");
  });

  it("keeps an operator turn that is not one", () => {
    const typed: SessionEventDto = {
      id: "e1",
      sessionId: "s-1",
      seq: 1,
      kind: "user_turn",
      payload: { kind: "user_turn", text: "actually use libSQL" },
      at: "2026-01-01T00:00:01.000Z",
    };
    // The filter keys on the marker, never on the wording — steering that happens to mention a
    // widget is still something a person said and still belongs in the transcript.
    expect(buildTranscript([typed], [])).toHaveLength(1);
  });

  it("drops an answer whose question is gone", () => {
    // Unlike a tool result, "someone answered something" says nothing without the question —
    // this happens when the widget itself sits inside a compacted range.
    const orphan: SessionEventDto = {
      id: "e9",
      sessionId: "s-1",
      seq: 9,
      kind: "widget_response",
      payload: { kind: "widget_response", widgetId: "gone", values: ["x"], text: null },
      at: "2026-01-01T00:00:09.000Z",
    };
    expect(buildTranscript([orphan], [])).toEqual([]);
  });

  it("shows a live widget once, not twice, when the socket replays it", () => {
    const live: TaskEvent = {
      kind: "widget",
      taskId: "t-1",
      sessionId: "s-1",
      seq: 0,
      widgetId: "w-1",
      widget: ASK,
    };
    // The persisted copy wins the dedup: it is the one that survived the database.
    expect(buildTranscript([persistedWidget(0)], [live])).toHaveLength(1);
  });
});

describe("registry", () => {
  it("has a renderer for every widget kind, including the fallback", () => {
    for (const kind of [
      "ask_user_input",
      "show_widget",
      "options_card",
      "step_card",
      "present_files",
      "unsupported",
    ] as const) {
      expect(rendererFor(kind)).toBeTruthy();
    }
  });
});

describe("AskUserInput", () => {
  it("offers a one-of-many question as radios, and answers on pick", () => {
    const sent: Array<[string[], string | undefined]> = [];
    render(<AskUserInput widget={ASK} onRespond={(v, t) => sent.push([v, t])} />);

    // Radios, not checkboxes: the role is what says "one of these" before the first click.
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("SQLite"));
    // One pick, one answer — a confirm step would add a click to every use.
    expect(sent).toEqual([[["sqlite"], undefined]]);
  });

  it("accumulates a multi-choice answer and sends it once", () => {
    const sent: string[][] = [];
    render(
      <AskUserInput widget={{ ...ASK, mode: "multi" }} onRespond={(values) => sent.push(values)} />,
    );

    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("PostgreSQL"));
    fireEvent.click(screen.getByLabelText("SQLite"));
    // Nothing is sent until the operator says they are done.
    expect(sent).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(sent).toEqual([["pg", "sqlite"]]);
  });

  it("offers a ranking in the agent's own order, and reorders it", () => {
    const sent: string[][] = [];
    render(
      <AskUserInput widget={{ ...ASK, mode: "rank" }} onRespond={(values) => sent.push(values)} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move SQLite up" }));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    expect(sent).toEqual([["sqlite", "pg"]]);
  });

  it("keeps the whole list once answered, ticked and no longer operable", () => {
    render(<AskUserInput widget={ASK} response={{ values: ["pg"], text: null }} />);
    // Both options stay: "they picked PostgreSQL" says nothing without what it beat.
    expect(screen.getByText("PostgreSQL")).toBeTruthy();
    expect(screen.getByText("SQLite")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box.hasAttribute("disabled")).toBe(true);
    }
  });

  it("says so when nobody answered before the run moved on", () => {
    // No `onRespond` and no response: the question is over and was never answered.
    render(<AskUserInput widget={ASK} />);
    expect(screen.getByText(/Unanswered/)).toBeTruthy();
  });
});

describe("ShowWidget", () => {
  const svg: Widget = {
    kind: "show_widget",
    module: "diagram",
    format: "svg",
    content: "<svg xmlns='http://www.w3.org/2000/svg'><circle r='4'/></svg>",
  };

  it("renders model-written markup in a sandboxed frame, never in this document", () => {
    const { container } = render(<ShowWidget widget={svg} />);
    // The markup must not be in the app's own DOM: an <img onerror> here would run beside the
    // operator's session.
    expect(container.querySelector("svg")).toBeNull();

    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute("srcdoc")).toContain("<circle r='4'/>");
  });

  it("gives a static module no script engine at all", () => {
    const { container } = render(<ShowWidget widget={svg} />);
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
  });

  it("allows scripts only for the modules that mean behaviour — and never same-origin", () => {
    const { container } = render(
      <ShowWidget
        widget={{ ...svg, module: "interactive", format: "html", content: "<p>x</p>" }}
      />,
    );
    const sandbox = container.querySelector("iframe")?.getAttribute("sandbox");
    expect(sandbox).toBe("allow-scripts");
    // `allow-same-origin` would hand the frame back the ability to reach this document, which is
    // the one token that would undo the whole sandbox.
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("locks the frame's own document down too", () => {
    const { container } = render(<ShowWidget widget={svg} />);
    const doc = container.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
    // Belt to the sandbox's braces: nothing external loads even if the sandbox were relaxed.
    expect(doc).toContain("default-src 'none'");
    expect(container.querySelector("iframe")?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
});
