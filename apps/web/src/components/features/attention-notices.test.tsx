/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { AttentionItemDto, AttentionListDto } from "@solow/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { WorkspaceEventsProvider } from "@/lib/workspace-events";
import { type FakeSocket, installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";

const pushed: string[] = [];
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => pushed.push(href),
    replace: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { AttentionNotices } = await import("./attention-notices");

/**
 * The notice when a run fails or gets stuck (FINDINGS F3): one toast per Task that joins the
 * "needs attention" list while the app is open — and none for what was already there.
 */

const AT = "2026-10-08T12:00:00.000Z";

function item(overrides: Partial<AttentionItemDto>): AttentionItemDto {
  return {
    taskId: "t-1",
    title: "Fix the login form",
    state: "failed",
    failureReason: "fail",
    kind: "failed",
    cause: "failed",
    since: AT,
    ...overrides,
  };
}

let sockets: FakeSocket[] = [];
let restore: () => void = () => {};

afterEach(() => {
  restore();
  cleanup();
  pushed.length = 0;
});

/** Renders the notices over a list the test can change, and returns the setter. */
function renderNotices(initial: AttentionListDto) {
  ({ sockets, restore } = installFakeWebSocket());
  let list = initial;
  let reads = 0;
  const result = renderWithTrpc(
    <WorkspaceEventsProvider>
      <AttentionNotices />
    </WorkspaceEventsProvider>,
    {
      "stream.ticket": () => ({ url: "ws://hub.test/stream?ticket=t" }),
      "health.attention": () => {
        reads += 1;
        return list;
      },
    },
  );
  return {
    ...result,
    setList: (next: AttentionListDto) => {
      list = next;
    },
    reads: () => reads,
  };
}

const empty: AttentionListDto = { items: [], truncated: false, recheckAt: null, recheckInMs: null };

/** Push a `status` frame through the shared socket, as the hub does when a Task changes. */
async function announce(state: "failed" | "parked" | "review") {
  await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
  act(() => sockets[0]?.emit({ kind: "status", taskId: "t-1", state, at: AT }));
}

describe("AttentionNotices", () => {
  it("does not replay what was already on the list when the app opened", async () => {
    const view = renderNotices({ ...empty, items: [item({})] });
    await waitFor(() => expect(view.reads()).toBe(1));
    expect(screen.queryByText(/Run failed/)).toBeNull();
  });

  it("tells the user when a run fails, and opens the Task from the notice", async () => {
    const view = renderNotices(empty);
    await waitFor(() => expect(view.reads()).toBe(1));

    view.setList({ ...empty, items: [item({ failureReason: "interrupted" })] });
    await announce("failed");

    expect(await screen.findByText("Run failed: Fix the login form")).toBeDefined();
    expect(screen.getByText(/Interrupted by restart/)).toBeDefined();
    fireEvent.click(screen.getByText("Open"));
    expect(pushed).toEqual(["/task/t-1"]);
  });

  it("tells the user when a run is stuck, though a stranded park is announced as `parked`", async () => {
    const view = renderNotices(empty);
    await waitFor(() => expect(view.reads()).toBe(1));

    view.setList({
      ...empty,
      items: [
        item({
          state: "parked",
          failureReason: "park_never_resumed",
          kind: "stuck",
          cause: "park_never_resumed",
        }),
      ],
    });
    await announce("parked");

    expect(await screen.findByText("Never resumed: Fix the login form")).toBeDefined();
  });

  it("looks again when the list says a quiet run is due, with no frame at all", async () => {
    // Due almost at once; the notices wait a moment past it before asking.
    const soon = new Date(Date.now() + 200).toISOString();
    const view = renderNotices({ ...empty, recheckAt: soon, recheckInMs: 200 });
    await waitFor(() => expect(view.reads()).toBe(1));

    view.setList({
      ...empty,
      items: [item({ state: "running", failureReason: null, kind: "stuck", cause: "run_silent" })],
    });

    expect(
      await screen.findByText("No activity: Fix the login form", {}, { timeout: 3_000 }),
    ).toBeDefined();
  });

  it("keeps looking on the server's schedule when the browser's clock disagrees with it", async () => {
    // The browser runs ten minutes ahead of the server: by its own clock every `recheckAt` is
    // already past. And the list does not change between reads, so each answer is identical.
    const skewed: AttentionListDto = {
      ...empty,
      recheckAt: new Date(Date.now() - 10 * 60_000 + 200).toISOString(),
      recheckInMs: 200,
    };
    const view = renderNotices(skewed);
    await waitFor(() => expect(view.reads()).toBe(1));

    // It waits the server's delay rather than firing at once, and an identical answer still
    // arms the next look.
    await waitFor(() => expect(view.reads()).toBeGreaterThanOrEqual(3), { timeout: 3_000 });

    view.setList({
      ...skewed,
      items: [item({ state: "running", failureReason: null, kind: "stuck", cause: "run_silent" })],
    });
    expect(
      await screen.findByText("No activity: Fix the login form", {}, { timeout: 3_000 }),
    ).toBeDefined();
  });

  it("does not repeat a notice for a Task still on the list", async () => {
    const view = renderNotices(empty);
    await waitFor(() => expect(view.reads()).toBe(1));
    view.setList({ ...empty, items: [item({})] });
    await announce("failed");
    await screen.findByText("Run failed: Fix the login form");

    await announce("failed");
    await waitFor(() => expect(view.reads()).toBe(3));
    expect(screen.getAllByText("Run failed: Fix the login form")).toHaveLength(1);
  });

  it("sums up a burst rather than stacking a toast per Task", async () => {
    const view = renderNotices(empty);
    await waitFor(() => expect(view.reads()).toBe(1));
    view.setList({
      ...empty,
      items: ["a", "b", "c", "d"].map((id) => item({ taskId: id, title: `Task ${id}` })),
    });
    await announce("failed");

    expect(await screen.findByText("4 runs need attention")).toBeDefined();
    expect(screen.queryByText(/Run failed: Task a/)).toBeNull();
  });
});
