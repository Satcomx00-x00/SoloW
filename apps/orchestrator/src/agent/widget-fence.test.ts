import { describe, expect, it } from "bun:test";
import { MAX_WIDGET_CONTENT } from "@gatecontrol/contracts";
import { WidgetFenceScanner } from "./widget-fence.js";

/**
 * The scanner runs over a live stream, so almost every test here feeds text in pieces: the
 * failure this guards against is a fence split across two chunks being printed as raw JSON, or a
 * block that never closes swallowing the rest of the run's output.
 */

const ASK = '{"kind":"ask_user_input","prompt":"Which?","options":[{"id":"a","label":"A"}]}';

/** Feed a whole string one character at a time — the worst case a stream can produce. */
function scanByChar(input: string) {
  const scanner = new WidgetFenceScanner();
  let text = "";
  const widgets = [];
  for (const ch of input) {
    const out = scanner.push(ch);
    text += out.text;
    widgets.push(...out.widgets);
  }
  const last = scanner.flush();
  return { text: text + last.text, widgets: [...widgets, ...last.widgets] };
}

describe("WidgetFenceScanner", () => {
  it("passes prose through untouched", () => {
    const scanner = new WidgetFenceScanner();
    expect(scanner.push("Reading the config now.")).toEqual({
      text: "Reading the config now.",
      widgets: [],
    });
  });

  it("lifts a complete block out of the prose around it", () => {
    const scanner = new WidgetFenceScanner();
    const out = scanner.push(`before\n\`\`\`gatecontrol:widget\n${ASK}\n\`\`\`\nafter`);
    expect(out.text).toBe("before\nafter");
    expect(out.widgets).toHaveLength(1);
    expect(out.widgets[0]).toMatchObject({ kind: "ask_user_input", prompt: "Which?" });
  });

  it("survives a fence split across chunks, one character at a time", () => {
    const result = scanByChar(`ok\n\`\`\`gatecontrol:widget\n${ASK}\n\`\`\`\ndone`);
    // The raw JSON must never reach the transcript — this is the whole point of holding back.
    expect(result.text).toBe("ok\ndone");
    expect(result.widgets).toHaveLength(1);
    expect(result.widgets[0]?.kind).toBe("ask_user_input");
  });

  it("holds back a partial opener rather than printing it", () => {
    const scanner = new WidgetFenceScanner();
    expect(scanner.push("text ```gatecont").text).toBe("text ");
    expect(scanner.push("rol:widget\n" + ASK + "\n```").widgets).toHaveLength(1);
  });

  it("does not treat someone else's fence as a widget", () => {
    const scanner = new WidgetFenceScanner();
    const out = scanner.push("```ts\nconst a = 1;\n```");
    expect(out.widgets).toEqual([]);
    // The trailing backticks are held only because they could still become our opener; they are
    // released whole the moment the next chunk (or the end of the stream) settles it.
    expect(out.text + scanner.flush().text).toBe("```ts\nconst a = 1;\n```");
  });

  it("reads several blocks in one chunk, in order", () => {
    const scanner = new WidgetFenceScanner();
    const step = '{"kind":"step_card","steps":[{"id":"1","label":"Plan","state":"done"}]}';
    const out = scanner.push(
      `a\n\`\`\`gatecontrol:widget\n${ASK}\n\`\`\`\nb\n\`\`\`gatecontrol:widget\n${step}\n\`\`\`\nc`,
    );
    expect(out.text).toBe("a\nb\nc");
    expect(out.widgets.map((w) => w.kind)).toEqual(["ask_user_input", "step_card"]);
  });

  it("reports invalid JSON as an unsupported widget rather than dropping it", () => {
    const scanner = new WidgetFenceScanner();
    const out = scanner.push("```gatecontrol:widget\n{not json}\n```");
    expect(out.widgets[0]).toMatchObject({
      kind: "unsupported",
      reason: "The fenced block was not valid JSON.",
    });
  });

  it("says so when a catalogued widget is not built yet", () => {
    const scanner = new WidgetFenceScanner();
    const out = scanner.push('```gatecontrol:widget\n{"kind":"weather","city":"Paris"}\n```');
    expect(out.widgets[0]).toMatchObject({
      kind: "unsupported",
      requested: "weather",
      reason: "This widget is in the catalogue but not built yet.",
    });
  });

  it("accepts the catalogue's versioned name", () => {
    const scanner = new WidgetFenceScanner();
    const out = scanner.push(
      `\`\`\`gatecontrol:widget\n${ASK.replace("ask_user_input", "ask_user_input_v0")}\n\`\`\``,
    );
    expect(out.widgets[0]?.kind).toBe("ask_user_input");
  });

  it("gives up on a block that never closes instead of eating the transcript", () => {
    const scanner = new WidgetFenceScanner();
    const opener = "```gatecontrol:widget\n";
    expect(scanner.push(opener).text).toBe("");

    // Past the cap, the held block is released as the literal text it is.
    const filler = "x".repeat(MAX_WIDGET_CONTENT + 5000);
    const out = scanner.push(filler);
    expect(out.widgets).toEqual([]);
    expect(out.text.startsWith(opener)).toBe(true);
    expect(out.text.endsWith("x")).toBe(true);

    // And the scanner is usable again afterwards.
    expect(scanner.push("later").text).toBe("later");
  });

  it("releases an unclosed block when the stream ends", () => {
    const scanner = new WidgetFenceScanner();
    scanner.push('```gatecontrol:widget\n{"kind":"ask');
    const out = scanner.flush();
    expect(out.widgets).toEqual([]);
    expect(out.text).toContain("```gatecontrol:widget");
  });

  it("emits nothing at all for an empty chunk", () => {
    const scanner = new WidgetFenceScanner();
    expect(scanner.push("")).toEqual({ text: "", widgets: [] });
  });

  it("refuses a body larger than the contract allows, as an unsupported widget", () => {
    const scanner = new WidgetFenceScanner();
    const huge = JSON.stringify({
      kind: "show_widget",
      module: "art",
      format: "svg",
      content: "y".repeat(MAX_WIDGET_CONTENT + 1),
    });
    const out = scanner.push(`\`\`\`gatecontrol:widget\n${huge}\n\`\`\``);
    expect(out.widgets[0]?.kind).toBe("unsupported");
  });
});
