/// <reference types="bun-types" />
import type { TaskEvent } from "@solow/contracts";
import { streamChannel } from "@solow/core/stream";

/**
 * WebSocket hub (spec F09 / task TASK-018). In-memory pub/sub the workflow publishes to and
 * SPA clients subscribe to. Channels are Workspace-scoped so a client only sees its own
 * Workspace's streams (Principle V). Reconnect replay is served from the session_event log.
 */
type Listener = (msg: TaskEvent) => void;

export class EventHub {
  private readonly channels = new Map<string, Set<Listener>>();

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  publish(channel: string, msg: TaskEvent): void {
    const set = this.channels.get(channel);
    if (!set) return;
    for (const l of set) l(msg);
  }

  /**
   * Channel names come from `@solow/core/stream` so the name a ticket authorizes and
   * the name the workflow publishes to can never drift apart.
   */
  taskChannel(workspaceId: string, taskId: string): string {
    return streamChannel({ workspaceId, taskId });
  }

  /** Workspace-wide channel carrying Task status changes (the board subscribes here). */
  boardChannel(workspaceId: string): string {
    return streamChannel({ workspaceId, taskId: null });
  }
}

export const hub = new EventHub();
