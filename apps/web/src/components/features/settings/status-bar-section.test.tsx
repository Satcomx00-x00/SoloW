/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { preferenceFixture } from "@/components/features/status-bar/preference-fixture";
import { AppContextProvider } from "@/lib/app-context";
import { statusItemRegistry } from "@/lib/contributions";
import { renderWithTrpc } from "@/test/trpc-harness";
import { StatusBarSection } from "./status-bar-section";

/**
 * Arranging the status bar (issue #3, AC-3). What is asserted here is the *arrangement that gets
 * saved*, not the pixels: the order written out has to name every item, or the ones it omits fall
 * back to their registered priority and appear to jump on the next load.
 *
 * Every control is reached by its accessible name, which is also the assertion that it has one —
 * a row of bare chevrons is unusable by keyboard and screen reader alike.
 */

function renderSection() {
  const preferences = preferenceFixture();
  const result = renderWithTrpc(
    <AppContextProvider value={{ identity: null }}>
      <StatusBarSection />
    </AppContextProvider>,
    preferences.handlers,
  );
  return { ...result, preferences };
}

afterEach(cleanup);

describe("StatusBarSection", () => {
  it("lists every registered status item, including ones a predicate is currently hiding", () => {
    renderSection();

    // `status.dev-owner` and `status.identity` never appear on the bar together; both are the
    // user's to arrange, so both are listed.
    expect(screen.getByRole("checkbox", { name: "Local development owner" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Signed-in account" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Workspace" })).toBeDefined();
  });

  it("groups the list the way the bar is drawn, so every move it offers is one the bar can make", () => {
    renderSection();

    const left = screen.getByRole("region", { name: "Left of the status bar" });
    const right = screen.getByRole("region", { name: "Right of the status bar" });

    expect(left.textContent).toContain("Workspace");
    expect(right.textContent).toContain("Task count");
    expect(left.textContent).not.toContain("Task count");
  });

  it("saves a complete order when an item is moved, not just the pair that moved", async () => {
    const { preferences } = renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Move Signed-in account up" }));

    await waitFor(() =>
      expect(preferences.saved().order).toHaveLength(statusItemRegistry.list().length),
    );
    const { order } = preferences.saved();
    expect(order.indexOf("status.identity")).toBeLessThan(order.indexOf("status.dev-owner"));
  });

  it("moves an item back down again, so a move is reversible", async () => {
    const { preferences } = renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Move Signed-in account up" }));
    await waitFor(() =>
      expect(preferences.saved().order.indexOf("status.identity")).toBeLessThan(
        preferences.saved().order.indexOf("status.dev-owner"),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move Signed-in account down" }));

    await waitFor(() =>
      expect(preferences.saved().order.indexOf("status.dev-owner")).toBeLessThan(
        preferences.saved().order.indexOf("status.identity"),
      ),
    );
  });

  it("swaps a counter with the counter next to it, not with whatever is next in a global list", async () => {
    // The reproduction of a defect that made a move look like it worked: the list used to be one
    // interleaved sequence, so "down" on the first right-hand item swapped it with a left-hand
    // one — the saved order changed, this list changed, and the bar was byte-identical.
    const { preferences } = renderSection();

    fireEvent.click(screen.getByRole("button", { name: "Move Task count down" }));

    await waitFor(() => expect(preferences.saved().order.length).toBeGreaterThan(0));
    const { order } = preferences.saved();
    expect(order.indexOf("status.running")).toBeLessThan(order.indexOf("status.tasks"));
  });

  it("cannot move the first item of a side up, or the last one down", () => {
    renderSection();
    const right = screen.getByRole("region", { name: "Right of the status bar" });
    const rows = [...right.querySelectorAll("li")];
    const first = rows[0] as HTMLElement;
    const last = rows[rows.length - 1] as HTMLElement;

    expect(first.querySelector('button[aria-label$="up"]')?.hasAttribute("disabled")).toBe(true);
    expect(last.querySelector('button[aria-label$="down"]')?.hasAttribute("disabled")).toBe(true);
  });

  it("records a hidden item by id, and shows it again when re-checked", async () => {
    const { preferences } = renderSection();

    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace" }));
    await waitFor(() => expect(preferences.saved().hidden).toContain("status.workspace"));

    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace" }));
    await waitFor(() => expect(preferences.saved().hidden).not.toContain("status.workspace"));
  });

  it("reflects an arrangement that was already saved, rather than starting from the defaults", async () => {
    const preferences = preferenceFixture({ order: [], hidden: ["status.workspace"] });
    renderWithTrpc(
      <AppContextProvider value={{ identity: null }}>
        <StatusBarSection />
      </AppContextProvider>,
      preferences.handlers,
    );

    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Workspace" }).getAttribute("data-state")).toBe(
        "unchecked",
      ),
    );
  });
});
