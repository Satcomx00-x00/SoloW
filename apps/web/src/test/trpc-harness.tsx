import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderResult, render } from "@testing-library/react";
import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { ReactElement } from "react";
import type { AppRouter } from "@/server/routers";
import { trpc } from "@/trpc/react";

/**
 * Client-test harness (task TASK-024). Renders a wired component inside the real tRPC/React
 * Query providers, but swaps the HTTP link for one that answers from a supplied handler map —
 * so a component can be tested exactly as it ships (its own queries, mutations and
 * invalidations) without a server.
 *
 * A handler may return a value, a promise, or throw to simulate a server error.
 */

export type ProcedureHandler = (input: unknown) => unknown;
export type Handlers = Record<string, ProcedureHandler>;

/** Calls each procedure received, in order — assert against it to check what a UI sent. */
export interface CallLog {
  calls: Array<{ path: string; input: unknown }>;
}

function handlerLink(handlers: Handlers, log: CallLog): TRPCLink<AppRouter> {
  return () =>
    ({ op }) =>
      observable((observer) => {
        log.calls.push({ path: op.path, input: op.input });
        const handler = handlers[op.path];
        if (!handler) {
          observer.error(
            TRPCClientError.from(new Error(`no test handler for procedure "${op.path}"`)),
          );
          return;
        }
        Promise.resolve()
          .then(() => handler(op.input))
          .then((data) => {
            observer.next({ result: { type: "data", data } });
            observer.complete();
          })
          .catch((cause) => observer.error(TRPCClientError.from(cause as Error)));
      });
}

export interface HarnessResult extends RenderResult {
  log: CallLog;
}

export function renderWithTrpc(ui: ReactElement, handlers: Handlers = {}): HarnessResult {
  const log: CallLog = { calls: [] };
  const queryClient = new QueryClient({
    // Fail fast and stay quiet: a test asserting an error state should not wait on retries.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = trpc.createClient({ links: [handlerLink(handlers, log)] });

  const result = render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </trpc.Provider>,
  );
  return { ...result, log };
}

/** A stand-in socket the test drives directly. */
export interface FakeSocket {
  url: string;
  /** Deliver a frame exactly as the hub would — serialized, through `onmessage`. */
  emit(event: unknown): void;
  drop(): void;
  closed: boolean;
  /** Everything the component sent upstream, already parsed. */
  sent: unknown[];
}

/**
 * Replace the global WebSocket for the duration of a test. Components that subscribe to the
 * realtime hub would otherwise dial a socket that is not running (and retry on a timer). The
 * returned sockets let a test push frames through the component's real parsing path.
 */
export function installFakeWebSocket(): { sockets: FakeSocket[]; restore: () => void } {
  const original = globalThis.WebSocket;
  const sockets: FakeSocket[] = [];

  class FakeWebSocket {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    private readonly entry: FakeSocket;

    constructor(readonly url: string) {
      this.entry = {
        url,
        closed: false,
        sent: [],
        emit: (event) => this.onmessage?.({ data: JSON.stringify(event) }),
        drop: () => this.onclose?.(),
      };
      sockets.push(this.entry);
      // The real socket opens asynchronously; mirror that so effects settle the same way.
      queueMicrotask(() => this.onopen?.());
    }

    send(data: string): void {
      this.entry.sent.push(JSON.parse(data));
    }

    close(): void {
      this.entry.closed = true;
    }
  }

  (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  return {
    sockets,
    restore: () => {
      (globalThis as { WebSocket: unknown }).WebSocket = original;
    },
  };
}

/** Back-compat shorthand for tests that only need the socket to stay quiet. */
export function stubWebSocket(): () => void {
  return installFakeWebSocket().restore;
}
