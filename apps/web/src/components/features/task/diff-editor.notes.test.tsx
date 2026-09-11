/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { ReviewNote } from "@solow/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { DiffEditor } from "./diff-editor";
import type { LineAnchor } from "./review-notes";

/**
 * Taking notes on lines of a diff (F10 FR-7). The editor is handed one file's notes and the
 * three edits; what is pinned here is the anchor — a note lands on the line whose "+" was
 * pressed, on the new side when there is one — and that a read-only editor offers no "+" at all.
 */

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  " export { a, b };",
  "",
].join("\n");

function Harness({ mode = "inline" }: { mode?: "split" | "inline" }) {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  return (
    <>
      <DiffEditor
        patch={patch}
        path="src/a.ts"
        mode={mode}
        onModeChange={() => {}}
        notes={{
          notes,
          onAdd: (anchor: LineAnchor, text: string) =>
            setNotes((all) => [
              ...all,
              { repositoryId: "repo-1", path: "src/a.ts", ...anchor, text },
            ]),
          onEdit: (note, text) =>
            setNotes((all) => all.map((n) => (n === note ? { ...n, text } : n))),
          onRemove: (note) => setNotes((all) => all.filter((n) => n !== note)),
        }}
      />
      <output data-notes>{JSON.stringify(notes)}</output>
    </>
  );
}

const recorded = () => JSON.parse(document.querySelector("[data-notes]")?.textContent ?? "[]");

afterEach(cleanup);

describe("DiffEditor notes", () => {
  it("adds a note on the new-side line whose + was pressed, then shows it under that line", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add a note on line 2" }));
    const form = screen.getByRole("textbox", { name: "Note" });
    fireEvent.change(form, { target: { value: "why 3?" } });
    fireEvent.keyDown(form, { key: "Enter", metaKey: true });

    expect(recorded()).toEqual([
      { repositoryId: "repo-1", path: "src/a.ts", side: "new", line: 2, text: "why 3?" },
    ]);
    const thread = document.querySelector("[data-review-thread='new:2']") as HTMLElement;
    expect(within(thread).getByText("why 3?")).toBeDefined();
  });

  it("anchors a deleted line on the old side, and a paired row on the new", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add a note on old line 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(recorded()[0]).toMatchObject({ side: "old", line: 2 });
    cleanup();

    render(<Harness mode="split" />);
    // Row 2 in split mode pairs the deletion with the addition: the new side wins, and there is
    // one + for the row, not one per side.
    expect(screen.queryByRole("button", { name: "Add a note on old line 2" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a note on line 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(recorded()[0]).toMatchObject({ side: "new", line: 2 });
  });

  it("edits and deletes a saved note in place", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add a note on line 3" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(recorded()[0]?.text).toBe("second");

    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(recorded()).toEqual([]);
    expect(document.querySelector("[data-review-thread]")).toBeNull();
  });

  it("offers no + at all when the editor is read-only", () => {
    render(<DiffEditor patch={patch} path="src/a.ts" mode="inline" onModeChange={() => {}} />);
    expect(screen.queryByRole("button", { name: /Add a note/ })).toBeNull();
  });

  it("cancels a note with Escape, saving nothing", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add a note on line 1" }));
    const form = screen.getByRole("textbox", { name: "Note" });
    fireEvent.change(form, { target: { value: "never mind" } });
    fireEvent.keyDown(form, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Note" })).toBeNull();
    expect(recorded()).toEqual([]);
  });
});
