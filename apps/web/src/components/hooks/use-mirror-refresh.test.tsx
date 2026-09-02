/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, waitFor } from "@testing-library/react";
import { useMirrorRefresh } from "@/components/hooks/use-mirror-refresh";
import { WorkspaceEventsProvider } from "@/lib/workspace-events";
import { type FakeSocket, installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { trpc } from "@/trpc/react";

/**
 * What a screen re-reads when the poll says the mirror moved.
 *
 * The scopes are kept apart on purpose, and this is where that stays true: a six-hourly refresh
 * of a repository's label vocabulary must not make every open tab re-read every issue list. That
 * is the cost the whole push mechanism exists to avoid, and it would be reintroduced at the
 * client by one careless `invalidate()`.
 *
 * Asserted through the requests the client actually sends, not by spying on `invalidate` — an
 * invalidation that refetches nothing is not a refresh, and the point is the re-read.
 */

let sockets: FakeSocket[] = [];
let restore: () => void = () => {};

afterEach(() => {
  restore();
  cleanup();
});

/** Mounts the hook alongside the queries a real screen holds, so invalidation has something to do. */
function Screen() {
  useMirrorRefresh();
  trpc.issue.list.useQuery({ limit: 500 });
  trpc.issue.labelColors.useQuery({});
  trpc.project.allItems.useQuery({ projectId: "p1" });
  trpc.task.list.useQuery({ limit: 500 });
  return null;
}

const handlers = {
  "stream.ticket": () => ({ url: "ws://hub.test/stream?ticket=t" }),
  "issue.list": () => ({ items: [], nextCursor: null }),
  "issue.labelColors": () => [],
  "project.allItems": () => ({ items: [], truncated: false }),
  "task.list": () => ({ items: [], nextCursor: null }),
};

/** Every read the screen made, so a re-read shows up as a second entry for the same path. */
async function mount() {
  ({ sockets, restore } = installFakeWebSocket());
  const { log } = renderWithTrpc(
    <WorkspaceEventsProvider>
      <Screen />
    </WorkspaceEventsProvider>,
    handlers,
  );
  await waitFor(() => expect(log.calls.filter((c) => c.path === "issue.list")).toHaveLength(1));
  await waitFor(() => expect(sockets.length).toBe(1));
  return log;
}

const countOf = (log: { calls: Array<{ path: string }> }, path: string) =>
  log.calls.filter((c) => c.path === path).length;

describe("useMirrorRefresh", () => {
  it("re-reads the issue surfaces when the poll wrote issues", async () => {
    const log = await mount();

    act(() => {
      sockets[0]?.emit({ kind: "mirror", scope: "issues", at: "2026-09-02T12:00:00.000Z" });
    });

    await waitFor(() => expect(countOf(log, "issue.list")).toBe(2));
    // `project.allItems` too: a newly imported Issue joins the local Projects its Repository is
    // registered under, so the row appears in the project table and not only in the issue list.
    await waitFor(() => expect(countOf(log, "project.allItems")).toBe(2));
  });

  it("does not re-read issues for a label change", async () => {
    const log = await mount();

    act(() => {
      sockets[0]?.emit({ kind: "mirror", scope: "labels", at: "2026-09-02T12:00:00.000Z" });
    });

    await waitFor(() => expect(countOf(log, "issue.labelColors")).toBe(2));
    // The assertion this file exists for. Collapsing the two scopes would make a vocabulary
    // refresh cost every open tab a full issue re-read, for rows that did not move.
    expect(countOf(log, "issue.list")).toBe(1);
    expect(countOf(log, "project.allItems")).toBe(1);
  });

  it("ignores frames that are not about the mirror", async () => {
    const log = await mount();

    act(() => {
      sockets[0]?.emit({
        kind: "status",
        taskId: "11111111-1111-4111-8111-111111111111",
        state: "review",
        at: "2026-09-02T12:00:00.000Z",
      });
    });

    // A Task advancing is somebody else's business on this channel; the board handles it. This
    // hook must not turn every agent state change into four extra reads.
    await new Promise((r) => setTimeout(r, 250));
    expect(countOf(log, "issue.list")).toBe(1);
    expect(countOf(log, "issue.labelColors")).toBe(1);
    expect(countOf(log, "task.list")).toBe(1);
  });
});
