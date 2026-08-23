import { describe, expect, it } from "bun:test";
import {
  findMatches,
  highlightsInline,
  rowText,
  splitHighlights,
  stepMatch,
} from "./terminal-search";
import type { TranscriptRow } from "./transcript";

/**
 * Finding a string in a transcript. The rules worth pinning down are the ones a find bar is
 * judged on: it counts every occurrence rather than every row, it walks them in transcript
 * order, it wraps at both ends, and it does not quietly skip the rows it cannot draw a
 * highlight inside.
 */

const text = (id: string, body: string): TranscriptRow => ({
  kind: "text",
  id,
  sessionId: "s",
  seq: Number(id),
  channel: "assistant",
  text: body,
  open: false,
});

const tool = (id: string, name: string, input: Record<string, string>): TranscriptRow => ({
  kind: "tool",
  id,
  sessionId: "s",
  seq: Number(id),
  name,
  callId: null,
  input,
  status: "completed",
  result: null,
});

describe("rowText", () => {
  it("reads a tool call as its name and arguments", () => {
    // What someone searching for "pip" wants is the row where the agent ran pip — the chip it
    // renders as says almost none of that.
    expect(rowText(tool("1", "Bash", { command: "pip index versions colorama" }))).toContain("pip");
    expect(rowText(tool("1", "Bash", { command: "ls" }))).toContain("Bash");
  });

  it("reads a widget as its question and its options, never its markup", () => {
    const widget: TranscriptRow = {
      kind: "widget",
      id: "2",
      sessionId: "s",
      seq: 2,
      widgetId: "w",
      widget: {
        kind: "show_widget",
        module: "diagram",
        title: "Event flow",
        format: "svg",
        content: "<svg><rect/></svg>",
      },
      response: null,
    };
    expect(rowText(widget)).toContain("Event flow");
    // Matching inside agent-written markup would send a search for "rect" to every diagram.
    expect(rowText(widget)).not.toContain("svg><rect");
  });
});

describe("findMatches", () => {
  const rows = [
    text("1", "pip install pandas"),
    text("2", "no match here"),
    text("3", "pip again"),
  ];

  it("counts occurrences, not rows", () => {
    expect(findMatches([text("1", "pip pip pip")], "pip")).toHaveLength(3);
  });

  it("returns them in transcript order, numbered within their row", () => {
    expect(findMatches(rows, "pip")).toEqual([
      { rowId: "1", index: 0 },
      { rowId: "3", index: 0 },
    ]);
  });

  it("ignores case, because a log viewer that does not is used once", () => {
    expect(findMatches([text("1", "PIP Install")], "pip install")).toHaveLength(1);
  });

  it("finds nothing for an empty or blank query", () => {
    expect(findMatches(rows, "")).toEqual([]);
    expect(findMatches(rows, "   ")).toEqual([]);
  });

  it("matches rows that cannot highlight a substring", () => {
    // Refusing these would make search quietly wrong about the rows people search for most.
    const withTool = [tool("1", "Bash", { command: "pip index versions" })];
    expect(findMatches(withTool, "pip")).toEqual([{ rowId: "1", index: 0 }]);
    expect(highlightsInline(withTool[0] as TranscriptRow)).toBe(false);
    expect(highlightsInline(text("2", "x"))).toBe(true);
  });
});

describe("stepMatch", () => {
  it("wraps at both ends", () => {
    expect(stepMatch(3, 2, 1)).toBe(0);
    expect(stepMatch(3, 0, -1)).toBe(2);
  });

  it("has nowhere to step with no matches", () => {
    expect(stepMatch(0, 0, 1)).toBeNull();
  });
});

describe("splitHighlights", () => {
  it("splits around every occurrence, numbering them", () => {
    expect(splitHighlights("a pip b pip", "pip")).toEqual([
      { text: "a ", match: null },
      { text: "pip", match: 0 },
      { text: " b ", match: null },
      { text: "pip", match: 1 },
    ]);
  });

  it("keeps the original casing of what it matched", () => {
    // The highlight sits on the text as written; only the comparison is case-insensitive.
    expect(splitHighlights("PIP", "pip")).toEqual([{ text: "PIP", match: 0 }]);
  });

  it("returns the whole string untouched when there is nothing to find", () => {
    expect(splitHighlights("hello", "")).toEqual([{ text: "hello", match: null }]);
    expect(splitHighlights("hello", "zz")).toEqual([{ text: "hello", match: null }]);
  });
});
