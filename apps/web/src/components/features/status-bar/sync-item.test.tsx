/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { AppContextProvider } from "@/lib/app-context";
import { WorkspaceEventsProvider } from "@/lib/workspace-events";
import { type FakeSocket, installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { preferenceFixture } from "./preference-fixture";
import { StatusBar } from "./status-bar";
import { syncLanded } from "./status-items";

/**
 * The one segment on the bar that acts rather than reports.
 *
 * The assertions that carry the design are about what it says when it is *not* fine: a bar
 * reading "synced just now" while a repository has been rate limited since yesterday would be
 * wrong in exactly the situation the segment exists for, and a spinner that never resolves would
 * be worse than no spinner.
 */

const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();

function renderBar(handlers: Record<string, (input: unknown) => unknown>) {
  const preferences = preferenceFixture();
  return renderWithTrpc(
    <AppContextProvider value={{ identity: null }}>
      <WorkspaceEventsProvider>
        <StatusBar />
      </WorkspaceEventsProvider>
    </AppContextProvider>,
    {
      "task.list": () => ({ items: [], nextCursor: null }),
      "stream.ticket": () => ({ url: "ws://hub.test/stream?ticket=t" }),
      ...preferences.handlers,
      ...handlers,
    },
  );
}

let sockets: FakeSocket[] = [];
let restore: () => void = () => {};

afterEach(() => {
  restore();
  cleanup();
});

function withSocket() {
  ({ sockets, restore } = installFakeWebSocket());
}

describe("syncLanded", () => {
  const asked = "2026-09-01T12:00:00.000Z";

  it("is not landed while no watermark exists at all", () => {
    expect(syncLanded(asked, null)).toBe(false);
  });

  it("is not landed on a watermark stamped before the request", () => {
    // The reliable half of the mechanism: a pass that found no news announces nothing, so this
    // is what resolves the quiet case — and a stale watermark must not be read as an answer.
    expect(syncLanded(asked, "2026-09-01T11:59:59.000Z")).toBe(false);
  });

  it("is not landed on the very timestamp the request carries", () => {
    // Strictly greater: the watermark stamped before the request cannot be evidence of it.
    expect(syncLanded(asked, asked)).toBe(false);
  });

  it("is landed once a repository was read after the request", () => {
    expect(syncLanded(asked, "2026-09-01T12:00:01.000Z")).toBe(true);
  });
});

describe("the status bar's sync segment", () => {
  it("says nothing at all when no Repository is linked to a provider", async () => {
    withSocket();
    renderBar({
      "workspace.syncStatus": () => ({
        repositories: 0,
        syncedAt: null,
        stale: 0,
        staleReason: null,
      }),
    });

    // A button that cannot do anything invites a press and answers with silence.
    await waitFor(() => expect(screen.queryByText("0 tasks")).toBeDefined());
    expect(screen.queryByText(/sync/i)).toBeNull();
  });

  it("reports the age of the repository that is furthest behind", async () => {
    withSocket();
    renderBar({
      "workspace.syncStatus": () => ({
        repositories: 3,
        // The DAL hands back the *oldest* watermark, not the newest — see `getSyncStatus`.
        syncedAt: minutesAgo(4),
        stale: 0,
        staleReason: null,
      }),
    });

    expect(await screen.findByText("synced 4m ago")).toBeDefined();
  });

  it("says how many are behind rather than how recently one of them succeeded", async () => {
    withSocket();
    renderBar({
      "workspace.syncStatus": () => ({
        repositories: 3,
        syncedAt: minutesAgo(1),
        stale: 2,
        staleReason: "the provider is rate limiting this connection",
      }),
    });

    const button = await screen.findByText("2 behind");
    expect(button.closest("button")?.title).toContain("rate limiting");
  });

  it("admits it when a Repository has never been read", async () => {
    withSocket();
    renderBar({
      "workspace.syncStatus": () => ({
        repositories: 2,
        syncedAt: null,
        stale: 0,
        staleReason: null,
      }),
    });

    expect(await screen.findByText("not synced yet")).toBeDefined();
  });

  it("asks for a global sync when pressed, and reports back when nothing accepted it", async () => {
    withSocket();
    const { log } = renderBar({
      "workspace.syncStatus": () => ({
        repositories: 2,
        syncedAt: minutesAgo(2),
        stale: 0,
        staleReason: null,
      }),
      // A local run with no orchestrator. A spinner resolving into silence would be
      // indistinguishable from a sync that worked.
      "workspace.syncNow": () => ({ accepted: false, repositories: 2 }),
    });

    fireEvent.click(await screen.findByText("synced 2m ago"));

    await waitFor(() => expect(screen.getByText("sync unavailable")).toBeDefined());
    expect(log.calls.some((c) => c.path === "workspace.syncNow")).toBe(true);
  });

  it("stops spinning when the poll announces the pass instead", async () => {
    withSocket();
    renderBar({
      "workspace.syncStatus": () => ({
        repositories: 1,
        syncedAt: minutesAgo(9),
        stale: 0,
        staleReason: null,
      }),
      "workspace.syncNow": () => ({ accepted: true, repositories: 1 }),
    });

    fireEvent.click(await screen.findByText("synced 9m ago"));
    await waitFor(() => expect(screen.getByText("syncing…")).toBeDefined());
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));

    act(() => {
      sockets[0]?.emit({ kind: "mirror", scope: "issues", at: new Date().toISOString() });
    });

    await waitFor(() => expect(screen.queryByText("syncing…")).toBeNull());
  });
});
