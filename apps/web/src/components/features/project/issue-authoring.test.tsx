/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { groupLabelsByCategory, MarkdownField } from "./issue-authoring";

/**
 * The label grouping the create dialog and the edit drawer share (user request 2026-08-30):
 * five known scoped families become headed groups in a fixed order, everything else shares one
 * flat list. Pure, so it is tested here rather than through either surface's popover.
 */

const label = (name: string) => ({ name, color: null, description: null });

describe("groupLabelsByCategory", () => {
  it("splits the five known families into headed groups, in the fixed order", () => {
    const groups = groupLabelsByCategory([
      label("type/feat"),
      label("status::todo"),
      label("area/backend"),
      label("size/xl"),
      label("prio/p0"),
    ]);
    // Order is Area · Priority · Size · Status · Type regardless of input order.
    expect(groups.map((g) => g.heading)).toEqual(["Area", "Priority", "Size", "Status", "Type"]);
  });

  it("treats prio and priority as the same family, and lowercases the prefix match", () => {
    const groups = groupLabelsByCategory([label("Priority::high"), label("prio/p1")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBe("Priority");
    expect(groups[0]?.items.map((i) => i.short)).toEqual(["high", "p1"]);
  });

  it("puts everything unrecognised in one unheaded group after the known families", () => {
    const groups = groupLabelsByCategory([
      label("status/done"),
      label("wontfix"),
      label("needs-info"),
    ]);
    expect(groups.map((g) => g.heading)).toEqual(["Status", null]);
    const other = groups.find((g) => g.heading === null);
    // An ungrouped label keeps its whole name as the displayed value.
    expect(other?.items.map((i) => i.short)).toEqual(["wontfix", "needs-info"]);
  });

  it("keeps a plain-label repository as a single flat list — no headings at all", () => {
    const groups = groupLabelsByCategory([label("bug"), label("enhancement")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBeNull();
  });

  it("does not treat an empty prefix (`::x`, `/x`) as a category", () => {
    const groups = groupLabelsByCategory([label("::orphan"), label("/loose")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.heading).toBeNull();
    expect(groups[0]?.items.map((i) => i.short)).toEqual(["::orphan", "/loose"]);
  });
});

afterEach(cleanup);

/** Drives `MarkdownField` the way both surfaces do — controlled, with the value held above it. */
function Harness({ initial = "" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownField value={value} onChange={setValue} />;
}

const box = () => screen.getByLabelText("Description") as HTMLTextAreaElement;

/** Put the cursor where a person would have dragged it, then press a toolbar button. */
function selectAndPress(from: number, to: number, button: string) {
  const ta = box();
  ta.setSelectionRange(from, to);
  fireEvent.click(screen.getByRole("button", { name: button }));
}

describe("MarkdownField toolbar", () => {
  it("wraps the selection rather than replacing it", () => {
    render(<Harness initial="make this bold please" />);

    selectAndPress(10, 14, "Bold");

    expect(box().value).toBe("make this **bold** please");
  });

  it("inserts a hint word when nothing is selected, so the button is never a no-op", () => {
    render(<Harness />);

    selectAndPress(0, 0, "Italic");

    expect(box().value).toBe("_italic_");
  });

  it("prefixes every line the selection touches — and only those", () => {
    render(<Harness initial={"one\ntwo\nthree"} />);

    // Selecting from mid-"one" to the end of "two" prefixes both those lines from their own
    // starts, and leaves "three" alone because the selection never reached it.
    selectAndPress(1, 7, "Bulleted list");

    expect(box().value).toBe("- one\n- two\nthree");
  });

  it("prefixes all three when the selection spans them", () => {
    render(<Harness initial={"one\ntwo\nthree"} />);

    selectAndPress(0, 13, "Quote");

    expect(box().value).toBe("> one\n> two\n> three");
  });

  it("writes a task list as GitLab and GitHub both parse it", () => {
    render(<Harness initial="ship it" />);

    selectAndPress(0, 7, "Task list");

    expect(box().value).toBe("- [ ] ship it");
  });

  it("builds a link with the selection as the text, leaving the URL to fill in", () => {
    render(<Harness initial="the docs" />);

    selectAndPress(4, 8, "Link");

    expect(box().value).toBe("the [docs](https://)");
  });
});

/** Radix tabs switch on mousedown, so a bare click leaves the trigger inactive. */
const showPreview = () =>
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Preview" }), { button: 0 });

describe("MarkdownField preview", () => {
  it("renders the markdown rather than showing its source", () => {
    render(<Harness initial="# Heading" />);

    showPreview();

    // Rendered as a heading element — the point of previewing at all.
    expect(screen.getByRole("heading", { name: "Heading" })).toBeDefined();
  });

  it("says so when there is nothing to preview, rather than showing an empty box", () => {
    render(<Harness />);

    showPreview();

    expect(screen.getByText("Nothing to preview.")).toBeDefined();
  });
});
