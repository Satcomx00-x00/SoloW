/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TaskDto, TaskState } from "@gatecontrol/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type FakeSocket, installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { Board } from "./board";

/**
 * Wired board tests (tasks TASK-021 / TASK-024). Unlike the `BoardView` prop tests, these drive
 * the real component — its tRPC queries, its per-card actions and its realtime subscription —
 * to prove the board reflects a run advancing in the background without a reload.
 */

function makeTask(over: Partial<TaskDto> & { id: string; state: TaskState }): TaskDto {
  return {
    issueId: "issue-1",
    title: `Task ${over.id}`,
    agentProfileId: "agent-1",
    executorProfileId: "exec-1",
    repositories: [
      {
        id: "attach-1",
        repositoryId: "repo-1",
        baseRef: null,
        checkoutBranch: "gatecontrol/task-1",
        resultBranch: null,
        position: 0,
      },
    ],
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const ticket = {
  "stream.ticket": () => ({
    url: "ws://hub.test/?ticket=t",
    expiresAt: "2026-01-01T00:01:00.000Z",
  }),
};

let sockets: FakeSocket[];
let restore: () => void;

beforeEach(() => {
  ({ sockets, restore } = installFakeWebSocket());
});
afterEach(() => {
  restore();
  cleanup();
});

/** The column section for a lifecycle state, so assertions can be scoped to it. */
function column(label: string): HTMLElement {
  return screen.getByLabelText(`${label} column`);
}

describe("Board (wired)", () => {
  it("moves a Task to its new column when the orchestrator announces a status change", async () => {
    let state: TaskState = "running";
    renderWithTrpc(<Board />, {
      ...ticket,
      "task.list": () => [makeTask({ id: "task-1", state, title: "Fix the gate latch" })],
      // The board waits for the edges before it draws: an undelivered dependency query would
      // otherwise let a blocked card render as launchable (issue #6).
      "task.dependencies": () => [],
    });

    await waitFor(() => {
      expect(within(column("Running")).getByText("Fix the gate latch")).toBeDefined();
    });
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    // The board subscribes to the Workspace channel; the tenant key rides inside the ticket.
    expect(sockets[0]?.url).toContain("ticket=t");

    // The run advances in the background: the hub announces it, the board refetches.
    state = "review";
    act(() => {
      sockets[0]?.emit({
        kind: "status",
        taskId: "task-1",
        state: "review",
        at: "2026-01-01T00:05:00.000Z",
      });
    });

    await waitFor(() => {
      expect(within(column("Review")).getByText("Fix the gate latch")).toBeDefined();
    });
    expect(within(column("Running")).queryByText("Fix the gate latch")).toBeNull();
  });

  it("advances a Backlog Task to Ready through the card action", async () => {
    let state: TaskState = "backlog";
    const { log } = renderWithTrpc(<Board />, {
      ...ticket,
      "task.list": () => [makeTask({ id: "task-1", state, title: "Investigate servo" })],
      "task.dependencies": () => [],
      "task.move": (input) => {
        state = (input as { to: TaskState }).to;
        return makeTask({ id: "task-1", state });
      },
    });

    const action = await screen.findByRole("button", { name: "Ready" });
    fireEvent.click(action);

    await waitFor(() => {
      expect(within(column("Ready")).getByText("Investigate servo")).toBeDefined();
    });
    expect(log.calls.find((c) => c.path === "task.move")?.input).toEqual({
      id: "task-1",
      to: "ready",
    });
  });

  it("surfaces a rejected launch instead of failing silently", async () => {
    renderWithTrpc(<Board />, {
      ...ticket,
      "task.list": () => [makeTask({ id: "task-1", state: "ready", title: "Launchable" })],
      "task.dependencies": () => [],
      "task.launch": () => {
        throw new Error("concurrency_cap_reached");
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("concurrency_cap_reached");
    });
  });

  it("reports a failed board load rather than rendering an empty board", async () => {
    renderWithTrpc(<Board />, {
      ...ticket,
      "task.list": () => {
        throw new Error("UNAUTHORIZED");
      },
      "task.dependencies": () => [],
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("UNAUTHORIZED");
    });
  });
});
