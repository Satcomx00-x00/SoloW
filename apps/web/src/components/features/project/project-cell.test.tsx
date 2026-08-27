/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { ProjectFieldDto, ProjectFieldValue } from "@solow/contracts";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProjectCell } from "./project-cell";

/**
 * A cell is a fragment of a table, so the test supplies what the table supplies: one tooltip
 * provider. Rendering without it is how the missing provider in the panel was found — Radix
 * throws rather than degrading, which is the right behaviour and worth keeping visible.
 */
const render = (ui: React.ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>);

/**
 * The editable cell (spec F23 FR-4, Decision 0018).
 *
 * What is asserted here is the discipline, not the styling: a read-only field is a value with a
 * sentence rather than a disabled box, an edit commits once rather than per keystroke, and
 * nothing is rendered optimistically — the cell shows the value it was given, which is the value
 * the provider holds.
 */

afterEach(cleanup);

const field = (over: Partial<ProjectFieldDto> & Pick<ProjectFieldDto, "id">): ProjectFieldDto => ({
  providerFieldId: `p-${over.id}`,
  name: "Status",
  type: "single_select",
  options: [
    { id: "opt-todo", name: "Todo" },
    { id: "opt-doing", name: "In progress" },
  ],
  iterations: [],
  position: 0,
  readOnly: false,
  readOnlyReason: null,
  ...over,
});

describe("a field the provider cannot hold", () => {
  it("is a value with the provider's own sentence, never an input that would fail on save", () => {
    // FR-5. A greyed box is a dead end; "GitLab weights need a paid tier" is something a person
    // can act on.
    render(
      <ProjectCell
        field={field({
          id: "f1",
          name: "Estimate",
          type: "number",
          readOnly: true,
          readOnlyReason: "GitLab weights need a paid tier",
        })}
        value={{ type: "number", number: 5 }}
        rowTitle="Cap the upload size"
        onEdit={() => {}}
      />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("5")).toBeDefined();
  });
});

describe("a text field", () => {
  const textField = field({ id: "f1", name: "Notes", type: "text", options: [] });

  it("commits once, on blur, rather than once per keystroke", () => {
    // Every commit is a provider round trip. One per character would spend a rate limit writing
    // the prefixes of a word.
    const writes: Array<ProjectFieldValue | null> = [];
    render(
      <ProjectCell
        field={textField}
        value={{ type: "text", text: "old" }}
        rowTitle="A row"
        onEdit={(v) => writes.push(v)}
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "new value" } });
    expect(writes).toHaveLength(0);

    fireEvent.blur(input);
    expect(writes).toEqual([{ type: "text", text: "new value" }]);
  });

  it("does not write when nothing changed, so opening a cell is not an edit", () => {
    const writes: unknown[] = [];
    render(
      <ProjectCell
        field={textField}
        value={{ type: "text", text: "old" }}
        rowTitle="A row"
        onEdit={(v) => writes.push(v)}
      />,
    );

    fireEvent.blur(screen.getByRole("textbox"));

    expect(writes).toHaveLength(0);
  });

  it("clears the value when emptied, which is different from writing an empty string", () => {
    const writes: Array<ProjectFieldValue | null> = [];
    render(
      <ProjectCell
        field={textField}
        value={{ type: "text", text: "old" }}
        rowTitle="A row"
        onEdit={(v) => writes.push(v)}
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    expect(writes).toEqual([null]);
  });

  it("restores the provider's value on Escape", () => {
    const writes: unknown[] = [];
    render(
      <ProjectCell
        field={textField}
        value={{ type: "text", text: "old" }}
        rowTitle="A row"
        onEdit={(v) => writes.push(v)}
      />,
    );

    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "typed but abandoned" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.value).toBe("old");
    expect(writes).toHaveLength(0);
  });
});

describe("a number field", () => {
  it("never sends NaN — an unenterable value clears the field instead", () => {
    // A `type="number"` input reports an unparseable entry as the empty string, so what reaches
    // the commit is "cleared", not "NaN". Asserting the *write* rather than the keystroke is what
    // makes this a guarantee: whatever the browser does with the text, a number field must never
    // put NaN on the wire, where it would serialise as null and read as a deliberate clear.
    const writes: unknown[] = [];
    render(
      <ProjectCell
        field={field({ id: "f1", name: "Size", type: "number", options: [] })}
        value={{ type: "number", number: 3 }}
        rowTitle="A row"
        onEdit={(v) => writes.push(v)}
      />,
    );

    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "not a number" } });
    fireEvent.blur(input);

    expect(writes).toEqual([null]);
    expect(writes.some((w) => typeof w === "object" && w !== null && "number" in w)).toBe(false);
  });
});

describe("a single select", () => {
  it("is a combobox when it can be edited, and plain text when it cannot", () => {
    const status = field({ id: "f1" });
    const { rerender: rerenderRaw } = render(
      <ProjectCell
        field={status}
        value={{ type: "single_select", optionId: "opt-todo" }}
        rowTitle="A row"
        onEdit={() => {}}
      />,
    );
    expect(screen.getByRole("combobox")).toBeDefined();

    // The table itself never decides whether an edit is allowed — no handler, no control.
    rerenderRaw(
      <TooltipProvider>
        <ProjectCell
          field={status}
          value={{ type: "single_select", optionId: "opt-todo" }}
          rowTitle="A row"
        />
      </TooltipProvider>,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Todo")).toBeDefined();
  });

  it("names the row it belongs to, so forty Status controls are still navigable", () => {
    render(
      <ProjectCell
        field={field({ id: "f1" })}
        value={undefined}
        rowTitle="Cap the upload size"
        onEdit={() => {}}
      />,
    );

    expect(screen.getByRole("combobox", { name: /status for cap the upload size/i })).toBeDefined();
  });
});

describe("people", () => {
  it("shows them as avatars and never as an editor, because the row does not own them", () => {
    // F23 FR-8: assignees are the provider's. Editing them happens in the panel, through the
    // provider — a cell that assigned someone would be editing a copy.
    render(
      <ProjectCell
        field={field({ id: "f1", name: "Assignees", type: "user", options: [] })}
        value={{
          type: "user",
          users: [{ login: "ada", name: "Ada", avatarUrl: null }],
        }}
        rowTitle="A row"
        onEdit={() => {}}
      />,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
    // The login is the fallback: an avatar with no name is a circle, and a circle answers nobody's
    // question about who holds a row. Uppercasing is a style, so the text stays the login's own.
    expect(screen.getByText("ad")).toBeDefined();
  });
});

describe("an option's colour", () => {
  /*
   * The bug this covers, and it produced *no error at all*: Projects v2 stores an option's colour
   * as a palette **name** (`GREEN`), not a hex. Treating that as a colour yields `#GREEN`, which
   * CSS discards silently — every token fell back to grey and the column looked untouched.
   */
  const coloured = (color: string | undefined) =>
    field({
      id: "f1",
      name: "Status",
      options: [
        color === undefined ? { id: "o1", name: "Backlog" } : { id: "o1", name: "Backlog", color },
      ],
    });

  const styleOf = (color: string | undefined) => {
    const { container } = render(
      <ProjectCell
        field={coloured(color)}
        value={{ type: "single_select", optionId: "o1" }}
        rowTitle="A row"
      />,
    );
    return container.querySelector("span")?.getAttribute("style") ?? "";
  };

  it("renders GitHub's palette name as the colour it names", () => {
    expect(styleOf("GREEN")).toContain("#57AB5A");
  });

  it("accepts a hex too, because GitLab's scoped labels report one", () => {
    expect(styleOf("#aabbcc")).toContain("#aabbcc");
  });

  it("accepts a bare hex, which is the form GitHub uses for repository labels", () => {
    expect(styleOf("d73a4a")).toContain("#d73a4a");
  });

  it("stays neutral for a vocabulary neither provider has taught us", () => {
    // Inventing a hue for an unknown name would tell the reader something the provider never said.
    expect(styleOf("chartreuse-ish")).toBe("");
  });

  it("stays neutral when the provider reports no colour at all", () => {
    expect(styleOf(undefined)).toBe("");
  });
});

describe("the option list", () => {
  it("draws each option as the token it will become, in the provider's colour", async () => {
    /*
     * The mismatch this fixes: a chosen cell showed `Ready` in green and the menu it was chosen
     * from showed a neutral dot beside grey text. Two readings of one option, and picking one
     * meant reading the words rather than recognising the token.
     */
    render(
      <ProjectCell
        field={field({
          id: "f1",
          name: "Status",
          options: [
            { id: "o1", name: "Ready", color: "GREEN" },
            { id: "o2", name: "Blocked", color: "RED" },
          ],
        })}
        value={undefined}
        rowTitle="A row"
        onEdit={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: /Status for A row/ }));

    const ready = await screen.findByText("Ready");
    // The token wraps the name, and it is the wrapper that carries the colour.
    expect(ready.parentElement?.getAttribute("style")).toContain("#57AB5A");
    expect(screen.getByText("Blocked").parentElement?.getAttribute("style")).toContain("#E5534B");
  });

  it("still says where to add options for a field that has none", async () => {
    // SoloW cannot add them — the provider owns the field's vocabulary (Decision 0018).
    render(
      <ProjectCell
        field={field({ id: "f1", name: "Size", options: [] })}
        value={undefined}
        rowTitle="A row"
        onEdit={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: /Size for A row/ }));

    // The regression: this sentence used to live inside `CommandEmpty`, which cmdk draws in
    // response to a search — so the field with *no* options, the one case it was written for,
    // opened on a popover with a heading, a Clear row and no explanation whatsoever.
    expect(await screen.findByText(/has no options yet/)).toBeDefined();
  });
});
