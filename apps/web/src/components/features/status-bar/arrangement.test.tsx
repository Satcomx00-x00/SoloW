/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { StatusBarSection } from "@/components/features/settings/status-bar-section";
import { AppContextProvider } from "@/lib/app-context";
import { renderWithTrpc } from "@/test/trpc-harness";
import { preferenceFixture } from "./preference-fixture";
import { StatusBar } from "./status-bar";

/**
 * The arrangement UI and the bar it arranges, in one tree (issue #3, AC-3).
 *
 * The two are tested together because the defect they had could not be seen apart: the Settings
 * list reordered, the saved arrangement changed, every assertion about either passed, and the
 * bar rendered exactly what it had rendered before. What a user calls "reordering the status
 * bar" is this round trip, so this is the test that has to hold.
 */

const TASKS = [
  { id: "t1", title: "Keypad", state: "running" },
  { id: "t2", title: "Gate relay", state: "review" },
  { id: "t3", title: "Docs", state: "done" },
];

function renderBoth() {
  const preferences = preferenceFixture();
  const result = renderWithTrpc(
    <AppContextProvider value={{ identity: null }}>
      <StatusBarSection />
      <StatusBar />
    </AppContextProvider>,
    { "task.list": () => TASKS, ...preferences.handlers },
  );
  const bar = () => result.container.querySelector("footer")?.textContent ?? "";
  return { ...result, preferences, bar };
}

afterEach(cleanup);

describe("arranging the status bar", () => {
  it("moves the segment on the bar, not only the row in Settings", async () => {
    const { bar } = renderBoth();
    await waitFor(() => expect(screen.getByText("3 tasks")).toBeDefined());
    expect(bar().indexOf("3 tasks")).toBeLessThan(bar().indexOf("1 running"));

    fireEvent.click(screen.getByRole("button", { name: "Move Task count down" }));

    await waitFor(() => expect(bar().indexOf("1 running")).toBeLessThan(bar().indexOf("3 tasks")));
  });

  it("takes a segment off the bar when it is unticked, and puts it back when it is re-ticked", async () => {
    const { bar } = renderBoth();
    await waitFor(() => expect(bar()).toContain("local workspace"));

    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace" }));
    await waitFor(() => expect(bar()).not.toContain("local workspace"));

    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace" }));
    await waitFor(() => expect(bar()).toContain("local workspace"));
  });

  it("keeps a hidden segment listed in Settings, so it can be brought back at all", async () => {
    const { bar } = renderBoth();
    await waitFor(() => expect(bar()).toContain("local workspace"));

    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace" }));

    await waitFor(() => expect(bar()).not.toContain("local workspace"));
    expect(screen.getByRole("checkbox", { name: "Workspace" })).toBeDefined();
  });
});
