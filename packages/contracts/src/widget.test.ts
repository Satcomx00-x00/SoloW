import { describe, expect, it } from "bun:test";
import {
  MAX_WIDGET_CONTENT,
  normalizeWidgetName,
  parseWidget,
  validateWidgetResponse,
  WIDGET_CATALOG,
  type Widget,
  widgetExpectsResponse,
} from "./widget.js";

/**
 * The widget contract is read by a stream producer that must never throw and by a renderer that
 * must never be handed a shape it cannot draw, so the two properties under test are totality
 * (every input becomes *some* widget) and strictness (an answer can only name what was offered).
 */

const askPayload = {
  kind: "ask_user_input",
  prompt: "Which?",
  options: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
};

const ask = (over: Record<string, unknown> = {}) => parseWidget({ ...askPayload, ...over });

describe("parseWidget", () => {
  it("reads a well-formed widget", () => {
    expect(ask()).toMatchObject({ kind: "ask_user_input", mode: "single", allowOther: false });
  });

  it("accepts the catalogue's versioned names", () => {
    expect(normalizeWidgetName("ask_user_input_v0")).toBe("ask_user_input");
    expect(normalizeWidgetName(" Show-Widget ")).toBe("show_widget");
  });

  it("says a catalogued widget is not built yet, rather than pretending it does not exist", () => {
    const parsed = parseWidget({ kind: "weather", city: "Paris" });
    expect(parsed).toMatchObject({ kind: "unsupported", requested: "weather" });
    expect((parsed as { reason: string }).reason).toContain("not built yet");
  });

  it("distinguishes an unknown name from a malformed payload of a known one", () => {
    expect((parseWidget({ kind: "teleporter" }) as { reason: string }).reason).toBe(
      "No widget by that name.",
    );
    // A known kind that fails its schema reports the schema's own complaint.
    const bad = parseWidget({ kind: "ask_user_input", prompt: "" }) as { reason: string };
    expect(bad.reason).not.toBe("No widget by that name.");
  });

  it("never throws, whatever it is handed", () => {
    for (const input of [null, undefined, 42, "text", [], {}]) {
      expect(parseWidget(input).kind).toBe("unsupported");
    }
  });

  it("refuses a body past the size the log will carry", () => {
    const huge = {
      kind: "show_widget",
      module: "art",
      format: "svg",
      content: "x".repeat(MAX_WIDGET_CONTENT + 1),
    };
    expect(parseWidget(huge).kind).toBe("unsupported");
  });

  it("keeps the catalogue and the implemented union in step", () => {
    // Every `implemented` entry must actually parse into its own kind — otherwise the catalogue
    // promises a widget the union cannot express.
    const implemented = Object.entries(WIDGET_CATALOG)
      .filter(([, v]) => v.status === "implemented")
      .map(([k]) => k);
    expect(implemented).toEqual([
      "ask_user_input",
      "show_widget",
      "options_card",
      "step_card",
      "present_files",
    ]);
  });
});

describe("widgetExpectsResponse", () => {
  it("is true for the widgets that wait on a person", () => {
    expect(widgetExpectsResponse(ask())).toBe(true);
    expect(
      widgetExpectsResponse(
        parseWidget({ kind: "options_card", options: [{ id: "a", label: "A" }] }),
      ),
    ).toBe(true);
  });

  it("is false for the ones that are only drawn", () => {
    const step = parseWidget({
      kind: "step_card",
      steps: [{ id: "1", label: "Plan", state: "done" }],
    });
    expect(widgetExpectsResponse(step)).toBe(false);
  });
});

describe("validateWidgetResponse", () => {
  it("refuses an option the widget never offered", () => {
    expect(validateWidgetResponse(ask(), { widgetId: "w", values: ["z"], text: null })).toContain(
      "No option",
    );
  });

  it("refuses the same option twice", () => {
    const widget = ask({ mode: "multi" });
    expect(
      validateWidgetResponse(widget, { widgetId: "w", values: ["a", "a"], text: null }),
    ).toContain("twice");
  });

  it("wants exactly one answer for a single-choice question", () => {
    const widget = ask();
    expect(validateWidgetResponse(widget, { widgetId: "w", values: ["a"], text: null })).toBeNull();
    expect(validateWidgetResponse(widget, { widgetId: "w", values: [], text: null })).toBe(
      "Choose one option.",
    );
  });

  it("takes free text instead of an option when the widget offered a box", () => {
    const widget = ask({ allowOther: true });
    expect(
      validateWidgetResponse(widget, { widgetId: "w", values: [], text: "neither" }),
    ).toBeNull();
  });

  it("wants every option, once, for a ranking", () => {
    const widget = ask({ mode: "rank" });
    expect(
      validateWidgetResponse(widget, { widgetId: "w", values: ["b", "a"], text: null }),
    ).toBeNull();
    // A partial preference is not a ranking.
    expect(validateWidgetResponse(widget, { widgetId: "w", values: ["a"], text: null })).toBe(
      "Rank every option.",
    );
  });

  it("refuses an answer to something that was never a question", () => {
    const step: Widget = {
      kind: "step_card",
      steps: [{ id: "1", label: "Plan", state: "todo" }],
    };
    expect(validateWidgetResponse(step, { widgetId: "w", values: [], text: null })).toContain(
      "does not take an answer",
    );
  });
});

/**
 * Length limits clip the text they bound; they no longer delete the widget it was in.
 *
 * The bug: an agent asked a five-option question whose longest option label ran to 240
 * characters against a 200-character cap. The whole widget failed its schema, degraded to
 * `unsupported`, and the run sat blocked on an answer the operator had no way to give — the card
 * on screen offered nothing to click. A bound meant to keep the log readable had deleted the
 * question instead.
 */
describe("display text", () => {
  it("keeps the widget when a label runs long, and says the label was cut", () => {
    const widget = ask({ options: [{ id: "a", label: "x".repeat(700) }] }) as Widget & {
      options: Array<{ label: string }>;
    };
    expect(widget.kind).toBe("ask_user_input");
    expect(widget.options[0]?.label).toHaveLength(500);
    expect(widget.options[0]?.label.endsWith("…")).toBe(true);
  });

  it("leaves a label that fits exactly as the agent wrote it", () => {
    const label = "Rewrite the file from the actual imports";
    const widget = ask({ options: [{ id: "a", label }] }) as Widget & {
      options: Array<{ label: string }>;
    };
    expect(widget.options[0]?.label).toBe(label);
  });

  it("carries the 240-character option that used to destroy the question", () => {
    // The reported case, to the character.
    const widget = ask({ options: [{ id: "a", label: "y".repeat(240) }] });
    expect(widget.kind).toBe("ask_user_input");
  });

  it("still refuses an id that is too long — the answer has to name it back exactly", () => {
    // Structural, not display: a clipped id would stop matching the option it identifies, and an
    // answer naming it would be rejected as an option the widget never offered.
    expect(
      parseWidget({ ...askPayload, options: [{ id: "z".repeat(200), label: "A" }] }).kind,
    ).toBe("unsupported");
  });

  it("clips rather than refuses however long the text is", () => {
    // The clip runs before validation, so there is no size at which a readable field goes back to
    // costing the widget. That is the point: the bound protects the log, and the log is protected
    // whether the overflow was 40 characters or 40 kilobytes.
    const widget = ask({ options: [{ id: "a", label: "x".repeat(9000) }] }) as Widget & {
      options: Array<{ label: string }>;
    };
    expect(widget.kind).toBe("ask_user_input");
    expect(widget.options[0]?.label).toHaveLength(500);
  });
});
