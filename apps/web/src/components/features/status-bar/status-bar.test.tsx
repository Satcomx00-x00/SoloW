/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { SurfaceLayout } from "@solow/core";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { AppContextProvider } from "@/lib/app-context";
import { type ShellIdentity, statusItemRegistry } from "@/lib/contributions";
import { renderWithTrpc } from "@/test/trpc-harness";
import { preferenceFixture } from "./preference-fixture";
import { StatusBar } from "./status-bar";

/**
 * The status bar as the first real consumer of the contribution registries (issue #3).
 *
 * These assert through the surface, never through the registrations: the bar is rendered and the
 * segments are expected to turn up. That is the only way to catch the failure mode a registry has
 * and a hard-coded bar does not — a boot barrel that stops being imported, leaving a surface that
 * renders perfectly and shows nothing.
 */

const TASKS = [
  {
    id: "t1",
    title: "Keypad",
    state: "running",
    workflowId: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "t2",
    title: "Gate relay",
    state: "review",
    workflowId: null,
    updatedAt: "2026-01-01T00:00:01.000Z",
  },
  {
    id: "t3",
    title: "Docs",
    state: "done",
    workflowId: null,
    updatedAt: "2026-01-01T00:00:02.000Z",
  },
];

const PROBE_ID = "test.seam-probe";
const BROKEN_ID = "test.broken-probe";

/**
 * A stand-in feature module. It registers exactly the way `settings-commands.ts` does and
 * `status-bar.tsx` has never heard of it — which is AC-4 stated as a rendered fact rather than
 * as an import graph.
 *
 * Registered here rather than at import time, and removed again afterwards: these three
 * registries are module singletons shared by every test file in the bun process, so a probe left
 * behind would make what a sibling file asserts depend on which file bun loaded first.
 */
beforeAll(() => {
  statusItemRegistry.register({
    id: PROBE_ID,
    priority: 900,
    render: {
      label: "Seam probe",
      slot: "right",
      Component: () => <span>contributed without importing the bar</span>,
    },
  });
});

afterAll(() => statusItemRegistry.unregister(PROBE_ID));

function renderBar(identity: ShellIdentity | null = null, layout?: SurfaceLayout) {
  const preferences = layout ? preferenceFixture(layout) : preferenceFixture();
  return renderWithTrpc(
    <AppContextProvider value={{ identity }}>
      <StatusBar />
    </AppContextProvider>,
    { "task.list": () => ({ items: TASKS, nextCursor: null }), ...preferences.handlers },
  );
}

afterEach(cleanup);

describe("StatusBar", () => {
  it("renders the segments the registry resolved, in registered priority order", async () => {
    const { container } = renderBar();

    await waitFor(() => expect(screen.getByText("3 tasks")).toBeDefined());
    const text = container.textContent ?? "";
    expect(text.indexOf("local workspace")).toBeLessThan(text.indexOf("dev owner"));
    // Left of the bar (issue #3, user request 2026-09-08: the running/review tabs sit in the
    // bar's centre-left, ahead of the right-aligned counters), so the active tabs read before
    // the task count rather than after it.
    expect(text.indexOf("Keypad")).toBeLessThan(text.indexOf("3 tasks"));
    // Running before Review, within the one combined segment that replaced the two bare counts.
    expect(text.indexOf("Keypad")).toBeLessThan(text.indexOf("Gate relay"));
  });

  it("swaps the identity segment for the dev-owner one through a predicate, not a branch", () => {
    renderBar({ name: "Ada", email: "ada@example.com" });

    expect(screen.getByText("Ada")).toBeDefined();
    expect(screen.queryByText("dev owner")).toBeNull();
  });

  it("renders a segment a feature module contributed, without importing that module", async () => {
    renderBar();

    expect(await screen.findByText("contributed without importing the bar")).toBeDefined();
  });

  it("costs a contribution that throws its own slot, and no more than that (NFR-2)", async () => {
    // Without a boundary around each segment, this one throw takes the bar, the shell and the
    // route with it. React reports a caught error through console.error, so the reporting is
    // captured rather than left to scroll past — and asserted, because a contribution that
    // vanishes with no explanation is the failure mode after this one.
    const reported: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args.map(String).join(" "));
    });
    statusItemRegistry.register({
      id: BROKEN_ID,
      priority: 901,
      render: {
        label: "Broken probe",
        slot: "right",
        Component: () => {
          throw new Error("a plugin blew up while rendering");
        },
      },
    });

    try {
      renderBar();
      await waitFor(() => expect(screen.getByText("3 tasks")).toBeDefined());
      expect(screen.getByText("contributed without importing the bar")).toBeDefined();
      expect(screen.getByText("local workspace")).toBeDefined();
      expect(reported.some((line) => line.includes(BROKEN_ID))).toBe(true);
    } finally {
      statusItemRegistry.unregister(BROKEN_ID);
      spy.mockRestore();
    }
  });

  it("puts the user's saved arrangement ahead of the registered priorities", async () => {
    // Both left-slot segments, so the order the harness saves is the only thing that can move
    // them past each other — the registered priorities alone would put Workspace first.
    const { container } = renderBar(null, {
      order: ["status.dev-owner", "status.workspace"],
      hidden: [],
      shown: [],
      widths: {},
    });

    await waitFor(() => expect(screen.getByText("3 tasks")).toBeDefined());
    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text.indexOf("dev owner")).toBeLessThan(text.indexOf("local workspace"));
    });
  });

  it("gives a segment the user hid no space at all, rather than rendering it empty", async () => {
    renderBar(null, { order: [], hidden: ["status.workspace"], shown: [], widths: {} });

    await waitFor(() => expect(screen.getByText("3 tasks")).toBeDefined());
    await waitFor(() => expect(screen.queryByText("local workspace")).toBeNull());
  });
});

/**
 * A tab names its Task by the Issue's own number, not the Task's title (user request
 * 2026-09-08) — the identifier the rest of the product already uses to name a row of work.
 */
describe("a running task's tab", () => {
  const NUMBERED_TASKS = [
    {
      id: "t1",
      issueId: "iss-1",
      title: "Keypad",
      state: "running",
      workflowId: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  function renderNumberedBar(issue: { externalNumber: number | null }) {
    const preferences = preferenceFixture();
    return renderWithTrpc(
      <AppContextProvider value={{ identity: null }}>
        <StatusBar />
      </AppContextProvider>,
      {
        "task.list": () => ({ items: NUMBERED_TASKS, nextCursor: null }),
        "issue.get": () => issue,
        ...preferences.handlers,
      },
    );
  }

  it("shows the issue's number once it resolves, not the task's title", async () => {
    renderNumberedBar({ externalNumber: 90 });

    expect(await screen.findByText("#90")).toBeDefined();
    expect(screen.queryByText("Keypad")).toBeNull();
  });

  it("falls back to the task's title for an issue the provider never numbered", async () => {
    renderNumberedBar({ externalNumber: null });

    expect(await screen.findByText("Keypad")).toBeDefined();
  });
});
