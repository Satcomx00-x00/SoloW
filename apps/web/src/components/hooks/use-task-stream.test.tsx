/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskEvent, TaskInputAck } from "@gatecontrol/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { type ConnectFn, reconnectDelayMs, useTaskStream } from "./use-task-stream";

/**
 * Realtime hook tests (tasks TASK-018 / TASK-024). The socket is injected, so these assert the
 * contract that matters without a hub: the client presents the API-issued ticket, resumes from
 * the last `seq` it saw after a drop (no lost terminal history), and reports its status.
 */

afterEach(cleanup);

const TICKET_URL = "ws://hub.test/?ticket=signed-ticket";
const ticketHandler = {
  "stream.ticket": () => ({ url: TICKET_URL, expiresAt: "2026-01-01T00:01:00.000Z" }),
};

/** Records every URL dialled and hands back the socket callbacks for the test to drive. */
function recordingConnect() {
  const opened: string[] = [];
  const sockets: Array<{
    onEvent: (e: TaskEvent) => void;
    onAck: (a: TaskInputAck) => void;
    onOpen: () => void;
    onClose: () => void;
    closed: boolean;
    sent: string[];
  }> = [];
  const connect: ConnectFn = (url, handlers) => {
    opened.push(url);
    const entry = { ...handlers, closed: false, sent: [] as string[] };
    sockets.push(entry);
    handlers.onOpen();
    return {
      close: () => {
        entry.closed = true;
      },
      send: (data: string) => entry.sent.push(data),
    };
  };
  return { connect, opened, sockets };
}

/** Counts how many times it rendered, so a burst of frames can be shown to cost one render. */
function CountingProbe({ connect, renders }: { connect: ConnectFn; renders: { n: number } }) {
  const { events } = useTaskStream("task-1", { connect });
  renders.n += 1;
  return <span data-testid="count">{events.length}</span>;
}

function Probe({ connect }: { connect: ConnectFn }) {
  const [ack, setAck] = useState<TaskInputAck | null>(null);
  const { events, status, sendInput, stopAgent } = useTaskStream("task-1", {
    connect,
    onAck: setAck,
  });
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="count">{events.length}</span>
      <span data-testid="ack">{ack ? `${ack.ok}:${ack.action ?? ack.error}` : ""}</span>
      <pre data-testid="text">
        {events.map((e) => (e.kind === "stdout" ? e.text : "")).join("")}
      </pre>
      <button type="button" onClick={() => sendInput("keep going")}>
        Send
      </button>
      <button type="button" onClick={() => stopAgent()}>
        Stop
      </button>
    </div>
  );
}

describe("useTaskStream", () => {
  it("connects with the API-issued ticket and accumulates streamed output", async () => {
    const { connect, opened, sockets } = recordingConnect();
    renderWithTrpc(<Probe connect={connect} />, ticketHandler);

    await waitFor(() => expect(opened).toHaveLength(1));
    // The ticket is carried through verbatim; the replay cursor starts before the first event.
    expect(opened[0]).toContain("ticket=signed-ticket");
    expect(opened[0]).toContain("since=-1");
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("open"));

    act(() => {
      sockets[0]?.onEvent({
        kind: "stdout",
        taskId: "task-1",
        sessionId: "sess-1",
        seq: 0,
        text: "hello ",
        channel: "assistant",
      });
      sockets[0]?.onEvent({
        kind: "stdout",
        taskId: "task-1",
        sessionId: "sess-1",
        seq: 1,
        text: "world",
        channel: "assistant",
      });
    });

    await waitFor(() => expect(screen.getByTestId("text").textContent).toBe("hello world"));
    expect(screen.getByTestId("count").textContent).toBe("2");
  });

  it("resumes from the last seq after the connection drops (no lost history)", async () => {
    const { connect, opened, sockets } = recordingConnect();
    renderWithTrpc(<Probe connect={connect} />, ticketHandler);

    await waitFor(() => expect(opened).toHaveLength(1));
    act(() => {
      sockets[0]?.onEvent({
        kind: "stdout",
        taskId: "task-1",
        sessionId: "sess-1",
        seq: 4,
        text: "before the drop\n",
        channel: "assistant",
      });
      sockets[0]?.onClose();
    });

    await waitFor(() => expect(opened).toHaveLength(2), { timeout: 3_000 });
    expect(opened[1]).toContain("since=4");
    // Output received before the drop is still on screen after reconnecting.
    expect(screen.getByTestId("text").textContent).toBe("before the drop\n");
  });

  it("reports an error status when the ticket cannot be obtained", async () => {
    const { connect, opened } = recordingConnect();
    renderWithTrpc(<Probe connect={connect} />, {
      "stream.ticket": () => {
        throw new Error("UNAUTHORIZED");
      },
    });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    expect(opened).toHaveLength(0);
  });
});

describe("useTaskStream — batching", () => {
  it("commits a burst of frames in one render instead of one render per frame", async () => {
    // Each socket message is its own macrotask, so React cannot batch them itself. One render
    // per chunk meant re-deriving the whole transcript per chunk — the slowness the terminal
    // was reported for. The frames themselves must all survive; only the renders collapse.
    const { connect, sockets } = recordingConnect();
    const renders = { n: 0 };
    renderWithTrpc(<CountingProbe connect={connect} renders={renders} />, ticketHandler);
    await waitFor(() => expect(sockets).toHaveLength(1));

    const before = renders.n;
    act(() => {
      for (let seq = 0; seq < 40; seq += 1) {
        sockets[0]?.onEvent({
          kind: "stdout",
          taskId: "task-1",
          sessionId: "sess-1",
          seq,
          text: `chunk ${seq}`,
          channel: "assistant",
        });
      }
    });

    await waitFor(() => expect(screen.getByTestId("count").textContent).toBe("40"));
    // Forty frames, a handful of renders — not forty.
    expect(renders.n - before).toBeLessThan(10);
  });
});

describe("useTaskStream — steering the agent (TASK-022)", () => {
  it("sends operator input and a stop on the same socket the stream arrives on", async () => {
    const { connect, sockets } = recordingConnect();
    renderWithTrpc(<Probe connect={connect} />, ticketHandler);
    await waitFor(() => expect(sockets).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(sockets[0]?.sent.map((s) => JSON.parse(s))).toEqual([
      { kind: "input", taskId: "task-1", data: "keep going" },
      { kind: "stop", taskId: "task-1" },
    ]);
  });

  it("surfaces the hub's acknowledgement, including a refusal", async () => {
    const { connect, sockets } = recordingConnect();
    renderWithTrpc(<Probe connect={connect} />, ticketHandler);
    await waitFor(() => expect(sockets).toHaveLength(1));

    // Input that reached no running agent must not look delivered to the operator.
    act(() => sockets[0]?.onAck({ kind: "ack", ok: false, error: "agent_not_running" }));
    await waitFor(() =>
      expect(screen.getByTestId("ack").textContent).toBe("false:agent_not_running"),
    );
  });

  it("does not write into a dropped socket", async () => {
    const { connect, sockets } = recordingConnect();
    renderWithTrpc(<Probe connect={connect} />, ticketHandler);
    await waitFor(() => expect(sockets).toHaveLength(1));

    act(() => sockets[0]?.onClose());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(sockets[0]?.sent).toEqual([]);
  });
});

describe("reconnectDelayMs", () => {
  it("backs off exponentially and caps so an outage is not a busy loop", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(4)).toBe(8_000);
    expect(reconnectDelayMs(20)).toBe(10_000);
  });
});
