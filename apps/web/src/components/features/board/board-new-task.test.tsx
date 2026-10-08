/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CommonErrorCode } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";

/**
 * "New task" on the board (roadmap E2): the action is visible on every board, the empty board
 * offers it, and the one-sentence dialog starts the run through `task.quickStart`.
 */
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/projects/proj-1/board",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { Board } = await import("./board");
const { WorkspaceEventsProvider } = await import("@/lib/workspace-events");

let restore: () => void;
beforeEach(() => {
  ({ restore } = installFakeWebSocket());
});
afterEach(() => {
  restore();
  cleanup();
});

const repo = (id: string, name: string) => ({
  id,
  name,
  integrationId: null,
  externalFullName: null,
});

function renderBoard(handlers: Record<string, (input: unknown) => unknown> = {}) {
  return renderWithTrpc(
    <WorkspaceEventsProvider>
      <Board />
    </WorkspaceEventsProvider>,
    {
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00Z",
      }),
      "task.list": () => ({ items: [], nextCursor: null }),
      "task.dependencies": () => [],
      "workflow.list": () => {
        throw new Error(CommonErrorCode.FlagDisabled);
      },
      "repository.list": () => ({ items: [repo("repo-1", "gate")], nextCursor: null }),
      ...handlers,
    },
  );
}

describe("Board New task", () => {
  it("offers New task from the empty board as well as the toolbar", async () => {
    renderBoard();
    await screen.findByText("No tasks yet");
    expect(screen.getAllByRole("button", { name: /New task/ })).toHaveLength(2);
  });

  it("starts a task from one sentence, naming no repository when there is only one", async () => {
    const { log } = renderBoard({
      "task.quickStart": () => ({ task: { id: "t1" }, issueId: "i1" }),
    });
    await screen.findByText("No tasks yet");

    fireEvent.click(screen.getAllByRole("button", { name: /New task/ })[0] as HTMLElement);
    const field = await screen.findByLabelText("What should the agent do?");
    const start = screen.getByRole("button", { name: "Start task" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    fireEvent.change(field, { target: { value: "  Add a /health endpoint " } });
    fireEvent.click(start);

    await waitFor(() => expect(log.calls.some((c) => c.path === "task.quickStart")).toBe(true));
    expect(log.calls.find((c) => c.path === "task.quickStart")?.input).toEqual({
      prompt: "Add a /health endpoint",
    });
    await waitFor(() => expect(screen.queryByLabelText("What should the agent do?")).toBeNull());
  });

  it("asks for the repository when there are several", async () => {
    const { log } = renderBoard({
      "repository.list": () => ({
        items: [repo("repo-1", "gate"), repo("repo-2", "web")],
        nextCursor: null,
      }),
      "task.quickStart": () => ({ task: { id: "t1" }, issueId: "i1" }),
    });
    await screen.findByText("No tasks yet");
    fireEvent.click(screen.getAllByRole("button", { name: /New task/ })[0] as HTMLElement);
    fireEvent.change(await screen.findByLabelText("What should the agent do?"), {
      target: { value: "Do it" },
    });
    await screen.findByLabelText("Repository");
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() => expect(log.calls.some((c) => c.path === "task.quickStart")).toBe(true));
    // The first repository is preselected, so the question never blocks the common case.
    expect(log.calls.find((c) => c.path === "task.quickStart")?.input).toEqual({
      prompt: "Do it",
      repositoryId: "repo-1",
    });
  });

  it("states a refusal in words and keeps the sentence", async () => {
    renderBoard({
      "task.quickStart": () => {
        throw new Error("TASK_QUICK_NEEDS_PROFILES");
      },
    });
    await screen.findByText("No tasks yet");
    fireEvent.click(screen.getAllByRole("button", { name: /New task/ })[0] as HTMLElement);
    const field = (await screen.findByLabelText(
      "What should the agent do?",
    )) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "Do it" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));

    await screen.findByText(/Add a harness profile and an executor profile/);
    expect(field.value).toBe("Do it");
  });
});
