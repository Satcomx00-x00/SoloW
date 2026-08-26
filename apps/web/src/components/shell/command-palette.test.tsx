/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { SurfaceLayout } from "@gatecontrol/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Command, CommandList } from "@/components/ui/command";
import { AppContextProvider } from "@/lib/app-context";
import { type CommandActions, type CommandItem, commandRegistry } from "@/lib/contributions";
import { ContributedCommands } from "./command-palette";

/**
 * The command palette as a consumer of the command registry (issue #3, AC-2/AC-4).
 *
 * Rendered without the search half around it: the part under test is the one that used to be a
 * hardcoded list, and the queries, the router and the debounce are not what a registration has
 * to get past. What is asserted is that a registered command reaches the screen, that a `when`
 * predicate keeps one off it, and that choosing one runs through the actions the surface handed
 * it rather than anything it imported for itself.
 */

/** A contributed icon the test does not care about; only the entry's presence is under test. */
const NO_ICON = (() => null) as unknown as CommandItem["icon"];

const PROBE_ID = "test.palette-probe";
const HIDDEN_ID = "test.palette-hidden";

/**
 * Registered per run and removed again: the registries are module singletons shared by every
 * test file in the bun process, so a probe left behind would follow this file into the next one.
 */
beforeAll(() => {
  commandRegistry.register({
    id: PROBE_ID,
    priority: 900,
    render: {
      title: "Probe a contributed command",
      group: "Create",
      icon: NO_ICON,
      run: (actions) => actions.create("task"),
    },
  });
  commandRegistry.register({
    id: HIDDEN_ID,
    priority: 901,
    when: (ctx) => ctx.identity !== null,
    render: {
      title: "Only for a signed-in owner",
      group: "Create",
      icon: NO_ICON,
      run: () => {},
    },
  });
});

afterAll(() => {
  commandRegistry.unregister(PROBE_ID);
  commandRegistry.unregister(HIDDEN_ID);
});

const calls: { navigated: string[]; created: string[] } = { navigated: [], created: [] };
const actions: CommandActions = {
  navigate: (href) => calls.navigated.push(href),
  create: (kind) => calls.created.push(kind),
};

function renderPalette(
  identity: { name: string; email: string } | null = null,
  layout?: SurfaceLayout,
) {
  calls.navigated = [];
  calls.created = [];
  return render(
    <AppContextProvider value={{ identity }}>
      <Command shouldFilter={false}>
        <CommandList>
          <ContributedCommands actions={actions} layout={layout} />
        </CommandList>
      </Command>
    </AppContextProvider>,
  );
}

afterEach(cleanup);

describe("the command palette's entries", () => {
  it("offers the destinations the navigation list defines, as registrations", () => {
    renderPalette();

    // By role rather than by text: "Settings" is both a heading and a destination, and only one
    // of the two is a command a person can choose.
    const offered = screen.getAllByRole("option").map((option) => option.textContent);
    // The workspace destinations — the ones that exist with no Project selected. A board and an
    // issue list are reached through a Project now, and the palette cannot offer them statically
    // because it would have to name a Project to do it.
    expect(offered).toContain("Projects");
    expect(offered).toContain("Unassigned");
    expect(offered).toContain("Settings");
    expect(offered).toContain("New task");
  });

  /*
   * `commands` is one of the surfaces the preference API stores an arrangement for, so the
   * palette has to apply it. Without this the arrangement would be saveable, visible in
   * Settings, and silently ignored on the surface it describes.
   */
  it("hides a command the saved arrangement hides", () => {
    renderPalette(null, { order: [], hidden: [PROBE_ID] });

    expect(screen.queryByText("Probe a contributed command")).toBeNull();
  });

  it("offers the commands in the order the saved arrangement puts them in", () => {
    // Within the group, not across the palette: `COMMAND_GROUPS` fixes the heading order, and an
    // arrangement rearranges the commands, not the vocabulary they are filed under.
    const inCreateGroup = () =>
      screen
        .getAllByRole("option")
        .map((option) => option.textContent)
        .filter((title) => title === "Probe a contributed command" || title === "New task");

    renderPalette(null, { order: [], hidden: [] });
    const before = inCreateGroup();

    cleanup();
    renderPalette(null, { order: [PROBE_ID], hidden: [] });
    const after = inCreateGroup();

    expect(before).toEqual(["New task", "Probe a contributed command"]);
    expect(after).toEqual(["Probe a contributed command", "New task"]);
  });

  it("offers a command a feature module contributed, without importing that module", () => {
    renderPalette();

    expect(screen.getByText("Probe a contributed command")).toBeDefined();
  });

  it("leaves out a command whose predicate does not hold, rather than branching on the feature", () => {
    renderPalette();
    expect(screen.queryByText("Only for a signed-in owner")).toBeNull();

    cleanup();
    renderPalette({ name: "Ada", email: "ada@example.com" });
    expect(screen.getByText("Only for a signed-in owner")).toBeDefined();
  });

  it("runs a chosen command through the actions the surface supplied", () => {
    renderPalette();

    fireEvent.click(screen.getByText("Projects"));
    fireEvent.click(screen.getByText("New task"));

    expect(calls.navigated).toEqual(["/projects"]);
    expect(calls.created).toEqual(["task"]);
  });

  it("groups the entries under the headings the command vocabulary defines", () => {
    const { container } = renderPalette();
    const text = container.textContent ?? "";

    expect(text.indexOf("Go to")).toBeLessThan(text.indexOf("Create"));
    expect(text.indexOf("Create")).toBeLessThan(text.indexOf("Manage secrets"));
  });
});
