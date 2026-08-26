/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { fencesBalanced, type TranscriptRow } from "./transcript";
import { Transcript } from "./transcript-view";

/**
 * When a text block is parsed as markdown and when it is left as plain text.
 *
 * The bug this pins down: the last text row of a transcript is always marked `open` — nothing has
 * arrived after it — so an agent's final message rendered as raw backticks for as long as the run
 * stayed alive. For a run waiting on an answer, that is forever, and the message ending in a code
 * block is the one people actually read.
 */

const row = (text: string, open: boolean): TranscriptRow => ({
  kind: "text",
  id: "1",
  sessionId: "s",
  seq: 1,
  channel: "assistant",
  text,
  open,
});

const FENCED = "Pinned them:\n\n```\nnumpy==2.5.2\npandas==3.0.5\n```\n\nRun pip install.";

function show(rows: TranscriptRow[], query?: string) {
  return render(
    <Transcript
      rows={rows}
      onRespondPermission={() => {}}
      {...(query ? { search: { query, active: null } } : {})}
    />,
  );
}

afterEach(cleanup);

describe("fencesBalanced", () => {
  it("is true when every fence that opened was closed", () => {
    expect(fencesBalanced(FENCED)).toBe(true);
    expect(fencesBalanced("no fences at all")).toBe(true);
    expect(fencesBalanced("```a```\ntext\n```b```")).toBe(true);
  });

  it("is false mid-block", () => {
    expect(fencesBalanced("here it is:\n```\nnumpy==2.5")).toBe(false);
  });

  it("counts fences, not backticks", () => {
    // Inline code is one backtick and must not be mistaken for a block that never closed.
    expect(fencesBalanced("use `pip install -r requirements.txt` for that")).toBe(true);
  });
});

describe("text block rendering", () => {
  it("renders a settled block's fence as a code block", () => {
    const { container } = show([row(FENCED, false)]);
    expect(container.querySelector("pre")).toBeTruthy();
    expect(container.textContent).not.toContain("```");
  });

  it("renders the live tail as a code block too, once its fence is closed", () => {
    // This is the reported case: the agent's last message, run still alive, ending in a block.
    const { container } = show([row(FENCED, true)]);
    expect(container.querySelector("pre")).toBeTruthy();
    expect(container.textContent).not.toContain("```");
  });

  it("leaves a half-arrived fence as plain text", () => {
    // Parsed, it would swallow the rest of the turn and re-parse into something else on the next
    // chunk — so mid-block the raw characters are the honest rendering.
    const { container } = show([row("here it is:\n```\nnumpy==2.5", true)]);
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).toContain("```");
  });

  it("falls back to plain text while a search is running, whatever the fences say", () => {
    // Highlighting and markdown cannot both own the string; the one you asked for by typing wins.
    const { container } = show([row(FENCED, false)], "numpy");
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("mark")?.textContent).toBe("numpy");
  });
});

describe("thinking blocks", () => {
  const thought = (open: boolean): TranscriptRow => ({
    kind: "text",
    id: "t",
    sessionId: "s",
    seq: 1,
    channel: "thinking",
    text: "weighing two options",
    open,
  });

  it("keeps time under the label while the thought is still arriving", () => {
    const { container } = show([thought(true)]);
    expect(container.querySelectorAll(".thinking-dot")).toHaveLength(3);
  });

  it("stops the moment the thought settles", () => {
    // A settled thought is a record. Motion under it would report activity that has ended — the
    // one thing this indicator exists to rule out.
    const { container } = show([thought(false)]);
    expect(container.querySelectorAll(".thinking-dot")).toHaveLength(0);
  });
});
