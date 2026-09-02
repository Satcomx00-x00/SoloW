/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TaskDependencyDto, TaskDto, TaskState } from "@solow/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspaceEventsProvider } from "@/lib/workspace-events";
import { type FakeSocket, installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { moveRefusal } from "./blockers";
import { Board } from "./board";
import { TaskCard } from "./task-card";

/**
 * Board dependency tests (issue #6 AC-2 / AC-3 / AC-4). Drives the real `Board` through the tRPC
 * harness, so what is proved is what a reader of the board actually sees: a blocked card is
 * marked and cannot be launched, it stops being either the moment its blocker reaches Done, and
 * a refused edge names the cycle in titles rather than showing an error code.
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
        checkoutBranch: "solow/task-1",
        resultBranch: null,
        position: 0,
      },
    ],
    failureReason: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function makeEdge(
  taskId: string,
  blockedByTaskId: string,
  blockedByTitle: string,
  blockedByState: TaskState,
): TaskDependencyDto {
  return {
    taskId,
    blockedByTaskId,
    blockedByTitle,
    blockedByState,
    createdAt: "2026-01-01T00:00:00.000Z",
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

/**
 * Rendered inside `WorkspaceEventsProvider`, because that is where the board's live connection
 * comes from in the app.
 *
 * The board used to open its own socket. It now consumes the shell's single subscription — every
 * surface that wants to be live listens to the same channel for the same frames, so the fan-out
 * belongs on the client side of one connection rather than in one connection per surface. A test
 * that rendered the board bare would be testing a component that cannot receive an event, which
 * is not the component that ships.
 */
const Live = WorkspaceEventsProvider;

describe("Board dependencies", () => {
  it("marks a blocked card with a lock and its outstanding count, and disables Launch", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [
            makeTask({ id: "a", state: "ready", title: "Wire the latch" }),
            makeTask({ id: "b", state: "running", title: "Order the servo" }),
            makeTask({ id: "c", state: "backlog", title: "Cut the bracket" }),
          ],
          nextCursor: null,
        }),
        "task.dependencies": () => [
          makeEdge("a", "b", "Order the servo", "running"),
          makeEdge("a", "c", "Cut the bracket", "backlog"),
        ],
      },
    );

    const lock = await screen.findByRole("button", { name: "Blocked by 2 tasks" });
    expect(lock.textContent).toContain("2");
    expect((await screen.findByRole("button", { name: "Launch" })).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("leaves an unblocked Ready Task launchable", async () => {
    const { log } = renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [makeTask({ id: "a", state: "ready", title: "Wire the latch" })],
          nextCursor: null,
        }),
        "task.dependencies": () => [],
        "task.launch": () => makeTask({ id: "a", state: "running" }),
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "task.launch")).toBe(true);
    });
  });

  it("unblocks the card when its last predecessor reaches Done", async () => {
    let blockerState: TaskState = "running";
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [
            makeTask({ id: "a", state: "ready", title: "Wire the latch" }),
            makeTask({ id: "b", state: blockerState, title: "Order the servo" }),
          ],
          nextCursor: null,
        }),
        "task.dependencies": () => [makeEdge("a", "b", "Order the servo", blockerState)],
      },
    );

    await screen.findByRole("button", { name: "Blocked by 1 task" });

    // The blocker finishes in the background; the hub announces it and the board refetches both
    // the tasks and the edges.
    blockerState = "done";
    await waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    act(() => {
      sockets[0]?.emit({
        kind: "status",
        taskId: "b",
        state: "done",
        at: "2026-01-01T00:05:00.000Z",
      });
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled")).toBe(false);
    });
    expect(screen.queryByRole("button", { name: "Blocked by 1 task" })).toBeNull();
  });

  it("names the offending path with Task titles when an edge is refused as a cycle", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [
            makeTask({ id: "a", state: "backlog", title: "Wire the latch" }),
            makeTask({ id: "b", state: "backlog", title: "Order the servo" }),
          ],
          nextCursor: null,
        }),
        "task.dependencies": () => [],
        "task.addDependency": () => {
          throw new Error("TASK_DEPENDENCY_CYCLE: a → b → a");
        },
      },
    );

    // Open the picker from the card that would be blocked, then choose the offending Task.
    fireEvent.click((await screen.findAllByRole("button", { name: "Blocked by" }))[0] as Element);
    fireEvent.click(await screen.findByRole("option", { name: /Order the servo/ }));

    const dialog = await screen.findByText("That would create a circular dependency");
    const cycle = dialog.closest("[role='dialog']");
    expect(cycle?.textContent).toContain("Wire the latch");
    expect(cycle?.textContent).toContain("Order the servo");
    // Titles, not the ids the server had to send.
    expect(cycle?.textContent).not.toContain("TASK_DEPENDENCY_CYCLE");
  });

  it("shows no card until the dependency edges land, rather than a board that looks unblocked", async () => {
    // The Tasks and the edges are two requests. Drawing the board on the first one alone renders
    // every blocked card undimmed, lockless and with a live Launch button — the absence of edge
    // data read as readiness (AC-4).
    let landEdges: (edges: TaskDependencyDto[]) => void = () => {};
    const edges = new Promise<TaskDependencyDto[]>((resolve) => {
      landEdges = resolve;
    });

    const { log } = renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [makeTask({ id: "a", state: "ready", title: "Wire the latch" })],
          nextCursor: null,
        }),
        "task.dependencies": () => edges,
      },
    );

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "task.list")).toBe(true);
    });
    expect(screen.queryByText("Wire the latch")).toBeNull();
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();

    await act(async () => {
      landEdges([makeEdge("a", "b", "Order the servo", "running")]);
      await edges;
    });

    expect((await screen.findByRole("button", { name: "Launch" })).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("reports a failed dependency query instead of showing every Task as ready", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [makeTask({ id: "a", state: "ready", title: "Wire the latch" })],
          nextCursor: null,
        }),
        "task.dependencies": () => {
          throw new Error("edges unavailable");
        },
      },
    );

    expect((await screen.findByRole("alert")).textContent).toContain("edges unavailable");
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
    expect(screen.queryByText("Wire the latch")).toBeNull();
  });

  it("explains a refused move in a sentence instead of showing the wire code", async () => {
    // Dragging is the one way into Running that never meets the disabled Launch button, so the
    // server's `TASK_BLOCKED` used to reach the Owner verbatim. Driven here through the Ready
    // button, which reaches the same banner through the same mutation.
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [makeTask({ id: "a", state: "backlog", title: "Wire the latch" })],
          nextCursor: null,
        }),
        "task.dependencies": () => [],
        "task.move": () => {
          throw new Error("TASK_BLOCKED");
        },
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ready" }));

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("waiting on a task that isn't done");
    expect(banner.textContent).not.toContain("TASK_BLOCKED");
  });
});

describe("moveRefusal", () => {
  const blocker = makeEdge("a", "b", "Order the servo", "running");

  it("names what is outstanding when a blocked Task is dragged into Running", () => {
    expect(moveRefusal("ready", "running", [blocker])).toBe(
      "Can't start this task yet. Waiting on Order the servo (Running)",
    );
  });

  it("allows a move that is not a start, even while the Task is blocked", () => {
    expect(moveRefusal("backlog", "ready", [blocker])).toBeNull();
  });

  it("still refuses an illegal transition in the same shape", () => {
    expect(moveRefusal("ready", "done", [])).toBe("Can't move Ready → Done");
  });
});

describe("TaskCard in the drag overlay", () => {
  const task = makeTask({ id: "a", state: "ready", title: "Wire the latch" });
  const blockers = [makeEdge("a", "b", "Order the servo", "running")];

  it("keeps its lock but not its id, so the two copies of one dragged card do not collide", () => {
    render(
      <>
        <TaskCard task={task} blockers={blockers} />
        <TaskCard task={task} blockers={blockers} ghost />
      </>,
    );

    // One anchor for the lock badge's scroll to resolve to, not two.
    expect(document.querySelectorAll("#task-a")).toHaveLength(1);
    // And the copy under the cursor still reads as blocked, rather than un-blocking itself for
    // the length of the drag.
    expect(screen.getAllByRole("button", { name: "Blocked by 1 task" })).toHaveLength(2);
  });
});
