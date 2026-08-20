/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TaskDto } from "@gatecontrol/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { type FakeSocket, installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { TaskWorkspace } from "./task-workspace";

/**
 * Review workspace tests (tasks TASK-022 / TASK-024). The review gate is the enforcement point
 * for Principle I, so these assert that a decision is only offered when the Task is in Review,
 * that the controls lock while a decision is in flight (no double-approve), and that agent
 * output already recorded is shown.
 */

const TASK_ID = "task-1";
const SESSION_ID = "sess-1";

function task(over: Partial<TaskDto> = {}): TaskDto {
  return {
    id: TASK_ID,
    issueId: "issue-1",
    title: "Fix the gate latch",
    state: "review",
    agentProfileId: "agent-1",
    executorProfileId: "exec-1",
    repositoryId: "repo-1",
    baseRef: "main",
    resultBranch: null,
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const session = {
  id: SESSION_ID,
  taskId: TASK_ID,
  state: "awaiting_review" as const,
  diffRef: "gatecontrol/task-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
};

function detail(events: Array<{ kind: string; payload: unknown }> = []) {
  return {
    session,
    events: events.map((e, i) => ({
      id: `ev-${i}`,
      sessionId: SESSION_ID,
      seq: i,
      kind: e.kind,
      payload: e.payload,
      at: "2026-01-01T00:00:00.000Z",
    })),
    review: null,
  };
}

let restoreWebSocket: () => void;
let sockets: FakeSocket[];
beforeEach(() => {
  ({ sockets, restore: restoreWebSocket } = installFakeWebSocket());
});
afterEach(() => {
  restoreWebSocket();
  cleanup();
});

describe("TaskWorkspace review gate", () => {
  it("disables every review action while a decision is in flight", async () => {
    let settle: () => void = () => {};
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task(),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
      "review.decide": () =>
        new Promise<{ ok: true }>((resolve) => {
          settle = () => resolve({ ok: true });
        }),
    });

    const approve = await screen.findByRole("button", { name: /Approve/ });
    expect(approve.hasAttribute("disabled")).toBe(false);
    fireEvent.click(approve);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Approve/ }).hasAttribute("disabled")).toBe(true);
    });
    expect(screen.getByRole("button", { name: /Reject/ }).hasAttribute("disabled")).toBe(true);

    // A second click while pending must not record a second decision (Principle I).
    fireEvent.click(screen.getByRole("button", { name: /Approve/ }));
    settle();
    await waitFor(() => {
      expect(log.calls.filter((c) => c.path === "review.decide")).toHaveLength(1);
    });
  });

  it("requires feedback before changes can be requested", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task(),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
    });

    const request = await screen.findByRole("button", { name: /Request changes/ });
    expect(request.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText(/Feedback/), {
      target: { value: "Please add a regression test." },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Request changes/ }).hasAttribute("disabled")).toBe(
        false,
      );
    });
  });

  it("offers no review action until the Task reaches Review", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state: "running" }),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
    });

    expect(await screen.findByText(/Review actions become available/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("renders recorded agent output in the terminal panel", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task(),
      "session.listForTask": () => [session],
      "session.get": () => detail([{ kind: "stdout", payload: { text: "patched latch.ts\n" } }]),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
    });

    expect(await screen.findByText(/patched latch.ts/)).toBeDefined();
  });
});

describe("TaskWorkspace destructive actions", () => {
  it("does not reject on a single click — the discard is confirmed first", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task(),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
      "review.decide": () => ({ ok: true }),
    });

    fireEvent.click(await screen.findByRole("button", { name: /Reject/ }));
    // The click opens a confirmation; nothing has been decided yet.
    expect(log.calls.filter((c) => c.path === "review.decide")).toHaveLength(0);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("cannot be undone");

    fireEvent.click(screen.getByRole("button", { name: /Discard the changes/ }));
    await waitFor(() => {
      expect(log.calls.filter((c) => c.path === "review.decide")).toHaveLength(1);
    });
    expect(log.calls.find((c) => c.path === "review.decide")?.input).toMatchObject({
      decision: "reject",
      sessionId: SESSION_ID,
    });
  });

  it("cancelling the confirmation leaves the changes alone", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task(),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
      "review.decide": () => ({ ok: true }),
    });

    fireEvent.click(await screen.findByRole("button", { name: /Reject/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(log.calls.filter((c) => c.path === "review.decide")).toHaveLength(0);
  });

  it("approve stays a single click — it is not destructive", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task(),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
      "review.decide": () => ({ ok: true }),
    });

    fireEvent.click(await screen.findByRole("button", { name: /Approve/ }));
    await waitFor(() => {
      expect(log.calls.filter((c) => c.path === "review.decide")).toHaveLength(1);
    });
  });
});

describe("TaskWorkspace agent steering (TASK-022)", () => {
  const handlers = (state: TaskDto["state"]) => ({
    "task.get": () => task({ state }),
    "session.listForTask": () => [session],
    "session.get": () => detail(),
    "stream.ticket": () => ({
      url: "ws://hub.test/?ticket=t",
      expiresAt: "2026-01-01T00:01:00.000Z",
    }),
  });

  it("sends what the operator typed to the running agent, then clears the box", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("running"));
    const box = (await screen.findByLabelText(/Message the agent/)) as HTMLInputElement;
    await waitFor(() => expect(box.hasAttribute("disabled")).toBe(false));

    fireEvent.change(box, { target: { value: "also update the changelog" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));

    await waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));
    expect(sockets[0]?.sent[0]).toEqual({
      kind: "input",
      taskId: TASK_ID,
      data: "also update the changelog",
    });
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("offers no steering once the Task has left Running", async () => {
    // In Review the way to ask for more work is "request changes", which is recorded
    // (Principle I) — a back channel into the agent would bypass that.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("review"));
    const box = await screen.findByLabelText(/Message the agent/);
    expect(box.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Send/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Stop/ }).hasAttribute("disabled")).toBe(true);
  });

  it("confirms before stopping the agent, then sends the stop", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("running"));
    const stop = await screen.findByRole("button", { name: /Stop/ });
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));

    fireEvent.click(stop);
    expect(sockets[0]?.sent).toEqual([]);
    expect(await screen.findByRole("alertdialog")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Stop the agent/ }));
    await waitFor(() => expect(sockets[0]?.sent).toEqual([{ kind: "stop", taskId: TASK_ID }]));
  });

  it("tells the operator when the hub had no agent to give the input to", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("running"));
    const box = (await screen.findByLabelText(/Message the agent/)) as HTMLInputElement;
    await waitFor(() => expect(box.hasAttribute("disabled")).toBe(false));

    fireEvent.change(box, { target: { value: "are you there?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    // Silently swallowing this would leave the operator believing the agent got the message.
    act(() => sockets[0]?.emit({ kind: "ack", ok: false, error: "agent_not_running" }));
    expect(await screen.findByText(/No agent is running/)).toBeDefined();
  });
});

/**
 * An agent asking for permission, from the operator's chair (issue #58, AC-4). The frame goes
 * through the component's real parsing path, so what is under test is that the contract, the
 * hook and the dialog agree — not that a mock was called.
 */
describe("TaskWorkspace permission prompt (issue #58)", () => {
  const handlers = {
    "task.get": () => task({ state: "running" }),
    "session.listForTask": () => [session],
    "session.get": () => detail(),
    "stream.ticket": () => ({
      url: "ws://hub.test/?ticket=t",
      expiresAt: "2026-01-01T00:01:00.000Z",
    }),
  };

  const permissionFrame = {
    kind: "permission_request",
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    seq: 1,
    requestId: "req-1",
    title: "Write .env in the worktree",
    toolKind: "edit",
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  };

  it("opens the prompt when the agent asks, and sends the chosen option back", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers);
    await waitFor(() => expect(sockets[0]).toBeDefined());

    act(() => sockets[0]?.emit(permissionFrame));

    expect(await screen.findByRole("alertdialog")).toBeDefined();
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));

    await waitFor(() =>
      expect(sockets[0]?.sent).toEqual([
        { kind: "permission", taskId: TASK_ID, requestId: "req-1", optionId: "once" },
      ]),
    );
  });

  it("closes the prompt once the request is resolved, however it was resolved", async () => {
    // The deadline policy can settle it while nobody is looking; the dialog must not sit there
    // offering a choice that no longer reaches anything.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers);
    await waitFor(() => expect(sockets[0]).toBeDefined());

    act(() => sockets[0]?.emit(permissionFrame));
    expect(await screen.findByRole("alertdialog")).toBeDefined();

    act(() =>
      sockets[0]?.emit({
        kind: "permission_resolved",
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        seq: 2,
        requestId: "req-1",
        optionId: "once",
        decidedBy: "policy",
      }),
    );

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // ...and the transcript records what happened, so a reviewer sees it afterwards.
    expect(await screen.findByText(/permission once \(policy\)/)).toBeDefined();
  });
});
