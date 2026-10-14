"use client";

import type { TaskEvent } from "@solow/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { type StreamStatus, useEventStream } from "@/components/hooks/use-task-stream";

/**
 * One subscription to the Workspace channel, for the whole app.
 *
 * Every screen that wants to know when something changed used to open its own socket, and each
 * one costs a ticket mutation, a connection, and its own reconnect backoff. That was already two
 * on the board (the board itself and the status bar) and it grows with every feature that wants
 * to be live — which is every feature, because being told beats asking.
 *
 * They are all listening to the *same channel* for the *same frames*, so the fan-out belongs on
 * this side of the socket. One connection, opened by the shell, and every consumer registers a
 * callback on it.
 *
 * Listeners live in a ref rather than in state on purpose: a component subscribing must not
 * re-render every other subscriber, and the delivery loop must see the current set without
 * having been re-created when it changed.
 */

interface WorkspaceEvents {
  subscribe(listener: (event: TaskEvent) => void): () => void;
  status: StreamStatus;
}

const WorkspaceEventsContext = createContext<WorkspaceEvents | null>(null);

export function WorkspaceEventsProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<(event: TaskEvent) => void>());

  const onEvent = useCallback((event: TaskEvent) => {
    // A listener that throws must not stop the ones after it: they are unrelated features that
    // happen to share a connection, and one bad handler taking the others' events with it would
    // be the shared socket becoming a shared failure.
    for (const listener of listeners.current) {
      try {
        listener(event);
      } catch {
        // Swallowed for the reason above. The frame is a nudge to re-read; losing one costs a
        // refresh, and the next frame arrives on the same connection.
      }
    }
  }, []);

  const { status } = useEventStream({ onEvent });

  /*
   * Caught up after a reconnect, since the channel does not replay what it missed.
   *
   * Every consumer here re-reads on a frame, so a socket that drops — a laptop lid, an
   * orchestrator restart — leaves each of them showing whatever was true before the drop, and the
   * frames that would have corrected them are gone. Coming back is therefore when everything on
   * screen is re-read, once. Not on the first open: the page's queries have only just answered,
   * and doubling every page load to cover the instant between them and the socket is a poor trade
   * — the Task page, where that instant decides what the step strip shows, covers it itself.
   */
  const queryClient = useQueryClient();
  const wasOpen = useRef(false);
  useEffect(() => {
    if (status !== "open") return;
    if (wasOpen.current) void queryClient.invalidateQueries({ type: "active" });
    wasOpen.current = true;
  }, [status, queryClient]);

  const value = useMemo<WorkspaceEvents>(
    () => ({
      status,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => {
          listeners.current.delete(listener);
        };
      },
    }),
    [status],
  );

  return (
    <WorkspaceEventsContext.Provider value={value}>{children}</WorkspaceEventsContext.Provider>
  );
}

/**
 * React to frames on the Workspace channel.
 *
 * Outside a provider this is a no-op rather than a throw: the events are a *freshness*
 * mechanism, and a component rendered in a test harness or a future surface without the shell
 * around it should render, not crash. It falls back to reading nothing, which is the behaviour
 * every one of these screens had before the channel existed.
 */
export function useWorkspaceEvents(handler: (event: TaskEvent) => void): void {
  const events = useContext(WorkspaceEventsContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!events) return;
    // Registered through a ref so a caller passing an inline closure does not resubscribe on
    // every render — the pattern `useEventStream` already uses for the same reason.
    return events.subscribe((event) => handlerRef.current(event));
  }, [events]);
}

/** The shared connection's state, for anything that shows whether the app is live. */
export function useWorkspaceEventStatus(): StreamStatus {
  return useContext(WorkspaceEventsContext)?.status ?? "idle";
}
