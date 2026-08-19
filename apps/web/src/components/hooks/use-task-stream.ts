"use client";

import {
  type TaskEvent,
  type TaskInput,
  type TaskInputAck,
  taskStreamFrameSchema,
} from "@gatecontrol/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { trpc } from "@/trpc/react";

/**
 * Realtime subscription for the SPA (TASK-018 client half).
 *
 * The hub is a separate process with no access to the session cookie, so the flow is: ask the
 * API for a short-lived ticket (it checks session + Workspace ownership), connect with it, and
 * on every reconnect resume from the last `seq` seen so missed agent output is replayed rather
 * than lost. Nothing here names a Workspace — the tenant key lives inside the signed ticket.
 *
 * The socket is bidirectional: the same connection carries the operator's input and stop to the
 * agent (TASK-022). The hub acknowledges each one, so the terminal can say that input reached no
 * running agent instead of appearing to have delivered it.
 */

export type StreamStatus = "idle" | "connecting" | "open" | "reconnecting" | "error";

/** Socket factory, injected in tests so the hook can be driven without a real server. */
export interface StreamSocket {
  close(): void;
  send(data: string): void;
}
export type ConnectFn = (
  url: string,
  handlers: {
    onEvent: (event: TaskEvent) => void;
    onAck: (ack: TaskInputAck) => void;
    onOpen: () => void;
    onClose: () => void;
  },
) => StreamSocket;

const defaultConnect: ConnectFn = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (message) => {
    const parsed = taskStreamFrameSchema.safeParse(safeJson(message.data));
    // A malformed frame is dropped rather than thrown: one bad frame must not kill the stream.
    if (!parsed.success) return;
    if (parsed.data.kind === "ack") handlers.onAck(parsed.data);
    else handlers.onEvent(parsed.data);
  };
  socket.onclose = () => handlers.onClose();
  socket.onerror = () => socket.close();
  return { close: () => socket.close(), send: (data) => socket.send(data) };
};

function safeJson(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Reconnect backoff, capped so a hub outage does not turn into a busy loop. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 10_000);
}

export interface UseEventStreamOptions {
  /** Task-scoped stream; omit for the Workspace board channel. */
  taskId?: string | undefined;
  onEvent: (event: TaskEvent) => void;
  /** The hub's answer to something this client sent. */
  onAck?: ((ack: TaskInputAck) => void) | undefined;
  enabled?: boolean;
  connect?: ConnectFn;
}

/**
 * Subscribe to one channel. Returns the connection status for display; events are delivered to
 * `onEvent` (kept in a ref so a new closure each render does not tear the socket down).
 */
export function useEventStream({
  taskId,
  onEvent,
  onAck,
  enabled = true,
  connect = defaultConnect,
}: UseEventStreamOptions): { status: StreamStatus; send: (frame: TaskInput) => boolean } {
  const [status, setStatus] = useState<StreamStatus>("idle");
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onAckRef = useRef(onAck);
  onAckRef.current = onAck;
  const socketRef = useRef<StreamSocket | undefined>(undefined);
  const lastSeqRef = useRef(-1);
  const utils = trpc.useUtils();
  const requestTicket = useCallback(
    (input: { taskId?: string }) => utils.client.stream.ticket.mutate(input),
    [utils],
  );

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    const open = async () => {
      if (disposed) return;
      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      try {
        const { url } = await requestTicket(taskId ? { taskId } : {});
        if (disposed) return;
        const withCursor = new URL(url);
        withCursor.searchParams.set("since", String(lastSeqRef.current));
        socketRef.current = connect(withCursor.toString(), {
          onOpen: () => {
            attempt = 0;
            setStatus("open");
          },
          onEvent: (event) => {
            if ("seq" in event) lastSeqRef.current = Math.max(lastSeqRef.current, event.seq);
            onEventRef.current(event);
          },
          onAck: (ack) => onAckRef.current?.(ack),
          onClose: () => {
            if (disposed) return;
            // The socket is gone: forget it so a send cannot be written into a dead one.
            socketRef.current = undefined;
            scheduleRetry();
          },
        });
      } catch {
        if (!disposed) scheduleRetry();
      }
    };

    const scheduleRetry = () => {
      setStatus(attempt === 0 ? "error" : "reconnecting");
      retry = setTimeout(open, reconnectDelayMs(attempt));
      attempt += 1;
    };

    void open();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
      socketRef.current = undefined;
    };
  }, [enabled, taskId, connect, requestTicket]);

  /** Send a frame upstream. `false` means there was no open socket to send it on. */
  const send = useCallback((frame: TaskInput): boolean => {
    const socket = socketRef.current;
    if (!socket) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }, []);

  return { status, send };
}

/**
 * Live agent events for one Task, oldest first — what the terminal panel renders. `onEvent`
 * lets the caller react to an event as well (e.g. refetch the Task when its state changes).
 */
export function useTaskStream(
  taskId: string,
  options: {
    enabled?: boolean;
    connect?: ConnectFn;
    onEvent?: ((event: TaskEvent) => void) | undefined;
    onAck?: ((ack: TaskInputAck) => void) | undefined;
  } = {},
): {
  events: TaskEvent[];
  status: StreamStatus;
  /** Hand the agent a further instruction. `false` if the stream is not connected. */
  sendInput: (text: string) => boolean;
  /** Ask the agent to stop. `false` if the stream is not connected. */
  stopAgent: () => boolean;
} {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const callerRef = useRef(options.onEvent);
  callerRef.current = options.onEvent;
  const onEvent = useCallback((event: TaskEvent) => {
    setEvents((prev) => [...prev, event]);
    callerRef.current?.(event);
  }, []);
  const { status, send } = useEventStream({
    taskId,
    onEvent,
    onAck: options.onAck,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.connect ? { connect: options.connect } : {}),
  });
  const sendInput = useCallback(
    (text: string) => send({ kind: "input", taskId, data: text }),
    [send, taskId],
  );
  const stopAgent = useCallback(() => send({ kind: "stop", taskId }), [send, taskId]);

  return { events, status, sendInput, stopAgent };
}
