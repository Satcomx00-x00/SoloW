/// <reference types="bun-types" />

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { TaskEvent } from "@solow/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { type FakeSocket, installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { useWorkspaceEvents, WorkspaceEventsProvider } from "./workspace-events";

/**
 * One connection, several consumers (see `workspace-events.tsx`).
 *
 * The assertion that carries the whole point is the count: three live surfaces used to mean
 * three tickets, three sockets and three reconnect loops for three copies of the same frames.
 */

let sockets: FakeSocket[] = [];
let restore: () => void = () => {};

afterEach(() => {
  restore();
  cleanup();
});

function Listener({ name, onEvent }: { name: string; onEvent?: () => void }) {
  const seen: string[] = [];
  useWorkspaceEvents((event) => {
    onEvent?.();
    seen.push(event.kind);
  });
  return <span data-testid={name}>{seen.join(",")}</span>;
}

function Counter({ name }: { name: string }) {
  let count = 0;
  useWorkspaceEvents(() => {
    count += 1;
    const node = document.querySelector(`[data-testid="${name}"]`);
    if (node) node.textContent = String(count);
  });
  return <span data-testid={name}>0</span>;
}

const ticket = { "stream.ticket": () => ({ url: "ws://hub.test/stream?ticket=t" }) };
const frame = (kind: string): unknown =>
  kind === "mirror"
    ? { kind: "mirror", scope: "issues", at: "2026-09-01T12:00:00.000Z" }
    : { kind: "status", taskId: "t1", state: "review", at: "2026-09-01T12:00:00.000Z" };

describe("WorkspaceEventsProvider", () => {
  it("opens exactly one socket however many surfaces are listening", async () => {
    ({ sockets, restore } = installFakeWebSocket());
    renderWithTrpc(
      <WorkspaceEventsProvider>
        <Counter name="a" />
        <Counter name="b" />
        <Counter name="c" />
      </WorkspaceEventsProvider>,
      ticket,
    );

    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    // The number that matters: three listeners, one ticket, one connection.
    expect(sockets).toHaveLength(1);
  });

  it("delivers every frame to every listener", async () => {
    ({ sockets, restore } = installFakeWebSocket());
    renderWithTrpc(
      <WorkspaceEventsProvider>
        <Counter name="a" />
        <Counter name="b" />
      </WorkspaceEventsProvider>,
      ticket,
    );
    await waitFor(() => expect(sockets.length).toBe(1));

    act(() => {
      sockets[0]?.emit(frame("mirror"));
      sockets[0]?.emit(frame("status"));
    });

    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("2"));
    expect(screen.getByTestId("b").textContent).toBe("2");
  });

  it("costs a listener that throws its own frame, and no more than that", async () => {
    ({ sockets, restore } = installFakeWebSocket());
    const spy = spyOn(console, "error").mockImplementation(() => {});
    function Exploding() {
      useWorkspaceEvents(() => {
        throw new Error("a handler blew up");
      });
      return null;
    }
    try {
      renderWithTrpc(
        <WorkspaceEventsProvider>
          <Exploding />
          <Counter name="survivor" />
        </WorkspaceEventsProvider>,
        ticket,
      );
      await waitFor(() => expect(sockets.length).toBe(1));

      act(() => {
        sockets[0]?.emit(frame("status"));
      });

      // These are unrelated features that happen to share a connection. One bad handler taking
      // the others' events with it would be the shared socket becoming a shared failure.
      await waitFor(() => expect(screen.getByTestId("survivor").textContent).toBe("1"));
    } finally {
      spy.mockRestore();
    }
  });

  it("stops delivering to a surface that has gone away, without reconnecting", async () => {
    ({ sockets, restore } = installFakeWebSocket());
    // Unmounted from inside the tree rather than by re-rendering it: the provider has to stay
    // mounted for the assertion about the connection to mean anything.
    function Stage() {
      const [showSecond, setShowSecond] = useState(true);
      return (
        <WorkspaceEventsProvider>
          <Counter name="a" />
          {showSecond ? <Counter name="b" /> : null}
          <button type="button" onClick={() => setShowSecond(false)}>
            close b
          </button>
        </WorkspaceEventsProvider>
      );
    }
    renderWithTrpc(<Stage />, ticket);
    await waitFor(() => expect(sockets.length).toBe(1));

    fireEvent.click(screen.getByText("close b"));
    expect(screen.queryByTestId("b")).toBeNull();

    act(() => {
      sockets[0]?.emit(frame("status"));
    });

    await waitFor(() => expect(screen.getByTestId("a").textContent).toBe("1"));
    // A surface unmounting is not a reconnect: the connection belongs to the shell, not to it.
    expect(sockets).toHaveLength(1);
  });

  it("renders without a provider rather than throwing", () => {
    // A freshness mechanism must not be the reason a component cannot be rendered in a harness.
    const seen: TaskEvent[] = [];
    renderWithTrpc(<Listener name="bare" onEvent={() => seen.push({} as TaskEvent)} />, {});
    expect(screen.getByTestId("bare")).toBeDefined();
  });
});
