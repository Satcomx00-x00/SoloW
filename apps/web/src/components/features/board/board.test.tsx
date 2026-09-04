/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CommonErrorCode, type TaskDto, TaskErrorCode, type TaskState } from "@solow/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { BOARD_COLUMNS, STATE_LABELS } from "@/lib/task-states";
import { WorkspaceEventsProvider } from "@/lib/workspace-events";
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
        checkoutBranch: "solow/task-1",
        resultBranch: null,
        position: 0,
      },
    ],
    failureReason: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    // A Task on no Workflow — every Task while `ff-workflows` is off (issue #5).
    workflowId: null,
    workflowStepId: null,
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

describe("Board (wired)", () => {
  it("moves a Task to its new column when the orchestrator announces a status change", async () => {
    let state: TaskState = "running";
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [makeTask({ id: "task-1", state, title: "Fix the gate latch" })],
          nextCursor: null,
        }),
        // The board waits for the edges before it draws: an undelivered dependency query would
        // otherwise let a blocked card render as launchable (issue #6).
        "task.dependencies": () => [],
      },
    );

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
    const { log } = renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [makeTask({ id: "task-1", state, title: "Investigate servo" })],
          nextCursor: null,
        }),
        "task.dependencies": () => [],
        "task.move": (input) => {
          state = (input as { to: TaskState }).to;
          return makeTask({ id: "task-1", state });
        },
      },
    );

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

  it("surfaces a rejected launch as a sentence, not as the wire code", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [makeTask({ id: "task-1", state: "ready", title: "Launchable" })],
          nextCursor: null,
        }),
        "task.dependencies": () => [],
        "task.launch": () => {
          throw new Error(TaskErrorCode.ConcurrencyCapReached);
        },
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() => {
      const alert = screen.getByRole("alert").textContent ?? "";
      expect(alert).toContain("already running as many tasks as it allows");
      // The banner used to render `error.message` straight through, so an Owner who hit the cap
      // was shown TASK_CONCURRENCY_CAP_REACHED and left to guess.
      expect(alert).not.toContain(TaskErrorCode.ConcurrencyCapReached);
    });
  });

  it("falls back to a sentence for a code it does not know, rather than leaking it", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => ({
          items: [makeTask({ id: "task-1", state: "ready", title: "Launchable" })],
          nextCursor: null,
        }),
        "task.dependencies": () => [],
        "task.launch": () => {
          throw new Error("SOME_FUTURE_CODE");
        },
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));

    await waitFor(() => {
      const alert = screen.getByRole("alert").textContent ?? "";
      expect(alert).not.toContain("SOME_FUTURE_CODE");
      expect(alert.length).toBeGreaterThan(0);
    });
  });

  it("reports a failed board load rather than rendering an empty board", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.list": () => {
          throw new Error("UNAUTHORIZED");
        },
        "task.dependencies": () => [],
      },
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("UNAUTHORIZED");
    });
  });

  describe("credential-expired Tasks (spec AC-013, issue #63)", () => {
    const handlers = {
      ...ticket,
      "task.list": () => ({
        items: [
          makeTask({
            id: "cred-1",
            state: "failed",
            title: "Stuck",
            failureReason: "credential_expired",
          }),
        ],
        nextCursor: null,
      }),
      "task.dependencies": () => [],
      "profile.agent.list": () => ({
        items: [{ id: "agent-1", secretId: "secret-1", name: "Claude", agentCatalogId: "cat-1" }],
        nextCursor: null,
      }),
      "secret.list": () => [
        { id: "secret-1", name: "anthropic-api-key", kind: "api_key", usedBy: [] },
      ],
    };

    it("offers a Renew link naming the Secret that expired, to the pre-filled Settings form", async () => {
      renderWithTrpc(
        <Live>
          <Board />
        </Live>,
        handlers,
      );

      const renew = await screen.findByRole("link", { name: /Renew/ });
      expect(renew.getAttribute("href")).toBe(
        "/settings?section=secrets&renewSecret=anthropic-api-key",
      );
    });

    it("offers no Renew link for a Task that failed for any other reason", async () => {
      renderWithTrpc(
        <Live>
          <Board />
        </Live>,
        {
          ...handlers,
          "task.list": () => ({
            items: [
              makeTask({ id: "ord-1", state: "failed", title: "Crashed", failureReason: "fail" }),
            ],
            nextCursor: null,
          }),
        },
      );

      await screen.findByText("Crashed");
      expect(screen.queryByRole("link", { name: /Renew/ })).toBeNull();
    });
  });

  describe("Retry for a failed Task", () => {
    const handlers = {
      ...ticket,
      "task.dependencies": () => [],
      "profile.agent.list": () => ({ items: [], nextCursor: null }),
      "secret.list": () => [],
    };

    it("re-runs a Task that failed for a reason a fresh attempt can fix", async () => {
      const retried: unknown[] = [];
      renderWithTrpc(
        <Live>
          <Board />
        </Live>,
        {
          ...handlers,
          "task.list": () => ({
            items: [
              // The exact reason an orchestrator restart leaves behind (issue: an Owner reported a
              // Task's input box answering "No agent is running" forever after a restart) — Retry is
              // how it comes back, since the worktree and its commits were never touched.
              makeTask({
                id: "int-1",
                state: "failed",
                title: "Stuck",
                failureReason: "interrupted",
              }),
            ],
            nextCursor: null,
          }),
          "task.retry": (input) => {
            retried.push(input);
            return makeTask({ id: "int-1", state: "running", title: "Stuck", failureReason: null });
          },
        },
      );

      fireEvent.click(await screen.findByRole("button", { name: /Retry/ }));

      await waitFor(() => expect(retried).toEqual([{ id: "int-1" }]));
    });

    it("offers no Retry button for a credential-expired Task — Renew covers that path instead", async () => {
      renderWithTrpc(
        <Live>
          <Board />
        </Live>,
        {
          ...handlers,
          "task.list": () => ({
            items: [
              makeTask({
                id: "cred-1",
                state: "failed",
                title: "Needs a credential",
                failureReason: "credential_expired",
              }),
            ],
            nextCursor: null,
          }),
        },
      );

      await screen.findByText("Needs a credential");
      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    });

    it("offers no Retry button for a Task that has not failed", async () => {
      renderWithTrpc(
        <Live>
          <Board />
        </Live>,
        {
          ...handlers,
          "task.list": () => ({
            items: [makeTask({ id: "run-1", state: "running", title: "Working" })],
            nextCursor: null,
          }),
        },
      );

      await screen.findByText("Working");
      expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    });
  });
});

/**
 * The board with `ff-workflows` off — which is every Workspace by default (issue #5 AC-6).
 *
 * `workflow.list` sits on `workflowProcedure` and THROWS `FLAG_DISABLED` when the flag is off.
 * The board blanks itself on any `loadError`, so joining the Workflow query to that set would
 * replace the board with an error page for every Workspace that has not turned the flag on. That
 * is the single most likely way this change ships a regression, so it is asserted directly: with
 * the flag off the board is the seven lifecycle columns and nothing else, and no picker appears.
 */
describe("Board with ff-workflows off", () => {
  const flagOff = {
    ...ticket,
    "task.dependencies": () => [],
    "workflow.list": () => {
      throw new Error(CommonErrorCode.FlagDisabled);
    },
  };

  it("draws the same seven columns and the same empty-state count as before Workflows existed", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...flagOff,
        "task.list": () => ({
          items: [makeTask({ id: "task-1", state: "running", title: "Fix the gate latch" })],
          nextCursor: null,
        }),
      },
    );

    await screen.findByText("Fix the gate latch");
    for (const state of BOARD_COLUMNS) {
      expect(screen.getByLabelText(`${STATE_LABELS[state]} column`)).toBeDefined();
    }
    expect(screen.getAllByLabelText(/ column$/)).toHaveLength(BOARD_COLUMNS.length);
    // Six of seven still say "No tasks in …" — the flag-off board counts exactly as it did.
    expect(screen.getAllByText(/^No tasks in/)).toHaveLength(BOARD_COLUMNS.length - 1);
    // And the refusal never reaches the reader: a disabled flag is not a board failure.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Board columns" })).toBeNull();
  });

  it("still moves a card through the board's own mutation, with the same arguments", async () => {
    let state: TaskState = "backlog";
    const { log } = renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...flagOff,
        "task.list": () => ({
          items: [makeTask({ id: "task-1", state, title: "Investigate servo" })],
          nextCursor: null,
        }),
        "task.move": (input) => {
          state = (input as { to: TaskState }).to;
          return makeTask({ id: "task-1", state });
        },
      },
    );

    fireEvent.click(await screen.findByRole("button", { name: "Ready" }));
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Ready column")).getByText("Investigate servo"),
      ).toBeDefined();
    });
    expect(log.calls.find((c) => c.path === "task.move")?.input).toEqual({
      id: "task-1",
      to: "ready",
    });
  });
});

describe("Board with ff-workflows on", () => {
  it("offers the column picker once the Workspace has a Workflow to pick", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.dependencies": () => [],
        "task.list": () => ({
          items: [makeTask({ id: "task-1", state: "running", title: "Fix the gate latch" })],
          nextCursor: null,
        }),
        "workflow.list": () => [
          {
            id: "wf-1",
            name: "Plan then build",
            description: null,
            version: 1,
            stepCount: 2,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    );

    expect(await screen.findByRole("combobox", { name: "Board columns" })).toBeDefined();
    // Lifecycle until the operator says otherwise: the columns are never inferred from the data.
    expect(screen.getAllByLabelText(/ column$/)).toHaveLength(BOARD_COLUMNS.length);
  });

  it("shows no picker when the Workspace has the flag but no Workflows yet", async () => {
    renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      {
        ...ticket,
        "task.dependencies": () => [],
        "task.list": () => ({
          items: [makeTask({ id: "task-1", state: "running", title: "Fix the gate latch" })],
          nextCursor: null,
        }),
        "workflow.list": () => [],
      },
    );

    await screen.findByText("Fix the gate latch");
    expect(screen.queryByRole("combobox", { name: "Board columns" })).toBeNull();
  });
});
