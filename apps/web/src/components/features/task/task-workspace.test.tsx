/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  type SessionEventPayload,
  TaskDependencyErrorCode,
  type TaskDto,
  TaskErrorCode,
} from "@gatecontrol/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  type FakeSocket,
  type Handlers,
  installFakeWebSocket,
  renderWithTrpc,
} from "@/test/trpc-harness";

/**
 * `TaskWorkspace` reads `useRouter` (to land on the board after deleting the Task the page is
 * about), and no App Router is mounted here — `useRouter` throws an invariant rather than
 * returning undefined, so it has to be stubbed.
 *
 * This file used to pass without a stub of its own, by inheriting the process-global mock that
 * issue-detail.test.tsx and activity-bar.test.tsx install: `mock.module` replaces the module for
 * the whole bun:test run, not per file. That is a race, and this file lost it the moment its
 * import graph grew — which is exactly the leak issue-detail.test.tsx already documents. Owning
 * the stub here makes the file independent of which other test happens to load first.
 */
mock.module("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  usePathname: () => "/board",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { TaskWorkspace } = await import("./task-workspace");

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
    repositories: [
      {
        id: "attach-1",
        repositoryId: "repo-1",
        baseRef: "main",
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

const session = {
  id: SESSION_ID,
  taskId: TASK_ID,
  state: "awaiting_review" as const,
  diffRef: "gatecontrol/task-1",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: null,
};

/** Session detail, with the log's payloads typed the way the router now returns them (#2). */
function detail(payloads: SessionEventPayload[] = []) {
  return {
    session,
    events: payloads.map((payload, i) => ({
      id: `ev-${i}`,
      sessionId: SESSION_ID,
      seq: i,
      kind: payload.kind,
      payload,
      at: "2026-01-01T00:00:00.000Z",
    })),
    summaries: [],
    cursor: null,
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

  it("requests changes with no feedback panel to fill in first", async () => {
    // The gate used to hold a Textarea and refuse to submit until it had something in it, which
    // made "request changes" the one review action that could not be taken by pressing it. The
    // contract dropped the requirement (`reviewDecisionInput` no longer refines on it) and the
    // panel went with it, so the button is now live on arrival like Approve and Reject.
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

    const request = await screen.findByRole("button", { name: /Request changes/ });
    expect(request.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByPlaceholderText(/Feedback/)).toBeNull();

    fireEvent.click(request);
    await waitFor(() => {
      expect(log.calls.filter((c) => c.path === "review.decide")).toHaveLength(1);
    });
    // Nothing invents a feedback string on the way out — the agent resumes on the original brief.
    expect(log.calls.find((c) => c.path === "review.decide")?.input).toEqual({
      sessionId: SESSION_ID,
      decision: "request_changes",
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
      "session.get": () =>
        detail([{ kind: "assistant_turn", text: "patched latch.ts\n", thinking: false }]),
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
    toolCallId: null,
    requestId: "req-1",
    title: "Write .env in the worktree",
    toolKind: "edit",
    options: [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  };

  it("asks inline in the transcript, where the operator can still read what it is about", async () => {
    // The modal traps focus, so with it open an operator cannot see the tool call they are being
    // asked to approve. The inline card is the primary surface for exactly that reason; the
    // modal is kept only for when the question is on a panel nobody is looking at.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers);
    await waitFor(() => expect(sockets[0]).toBeDefined());

    act(() => sockets[0]?.emit(permissionFrame));

    const card = await screen.findByRole("group", {
      name: /Write \.env in the worktree/,
    });
    expect(card).toBeDefined();
    // No modal while the operator is already looking at the transcript it appeared in.
    expect(screen.queryByRole("alertdialog")).toBeNull();

    fireEvent.click(within(card).getByRole("button", { name: "Allow once" }));

    await waitFor(() =>
      expect(sockets[0]?.sent).toEqual([
        { kind: "permission", taskId: TASK_ID, requestId: "req-1", optionId: "once" },
      ]),
    );
  });

  it("escalates to the modal when the question is on a panel nobody is looking at", async () => {
    // An agent is blocked on the answer, so a question the operator cannot see has to interrupt.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers);
    await waitFor(() => expect(sockets[0]).toBeDefined());

    // Radix activates a tab on focus, not on a bare click. Conversation is the other panel now
    // that Changes is a column beside the terminal rather than a tab.
    const otherTab = await screen.findByRole("tab", { name: /Conversation/ });
    fireEvent.mouseDown(otherTab);
    fireEvent.focus(otherTab);
    fireEvent.click(otherTab);
    // Wait for the panel to actually swap: the escalation is decided from which panel is
    // showing, so emitting while the terminal is still mounted would prove nothing.
    await waitFor(() => expect(otherTab.getAttribute("aria-selected")).toBe("true"));

    act(() => sockets[0]?.emit(permissionFrame));

    expect(await screen.findByRole("alertdialog")).toBeDefined();
  });

  it("stops offering a choice once the request is settled, however it was settled", async () => {
    // The deadline policy can settle it while nobody is looking; the card must not sit there
    // offering a choice that no longer reaches anything.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers);
    await waitFor(() => expect(sockets[0]).toBeDefined());

    act(() => sockets[0]?.emit(permissionFrame));
    expect(await screen.findByRole("button", { name: "Allow once" })).toBeDefined();

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

    // Wait on the settled copy appearing rather than on the button vanishing: a `waitFor` over a
    // negative assertion re-serialises the whole DOM on every retry, which on this page is slow
    // enough to look like a hang.
    expect(await screen.findByText(/settled by policy/i)).toBeDefined();
    // ...and with it settled, the choice is gone: a question that no longer reaches anything must
    // not still be offering buttons.
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });
});

/**
 * The Changes tab across several Repositories (issue #7 AC-4).
 *
 * A Task can now span several, and a reviewer shown one flat file list could not tell which
 * repository a path came from. `DiffView` is reused unchanged inside each group.
 */
describe("the Changes tab of a multi-Repository Task", () => {
  const change = (path: string) => ({
    files: [{ path, status: "modified" as const, additions: 2, deletions: 1 }],
    patch: `--- a/${path}\n+++ b/${path}\n`,
    truncated: false,
  });

  function detailWithDiffs(diffs: unknown[]) {
    return { ...detail(), diffs, diff: diffs[0] ?? null };
  }

  /** Radix activates a tab on mousedown/focus, not on click. */
  /**
   * Changes is a column beside the terminal now, not a tab, so there is nothing to open — it is
   * mounted from the first paint. The helper stays as a no-op rather than being deleted from
   * each test, so the cases below still read as "given the changes are on screen".
   */
  async function openChangesTab(): Promise<void> {
    await screen.findByRole("complementary", { name: "Changes" });
  }

  const baseHandlers = {
    "task.get": () => task(),
    "session.listForTask": () => [session],
    "stream.ticket": () => ({
      url: "ws://hub.test/?ticket=t",
      expiresAt: "2026-01-01T00:01:00.000Z",
    }),
  };

  it("renders one labelled group per Repository, with each repository's own branch", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "session.get": () =>
        detailWithDiffs([
          {
            diffRef: "gatecontrol/task-1",
            repositoryId: "repo-1",
            repositoryName: "api",
            ...change("src/api.ts"),
          },
          {
            diffRef: "feature/lib",
            repositoryId: "repo-2",
            repositoryName: "shared-lib",
            ...change("src/lib.ts"),
          },
        ]),
    });

    await openChangesTab();

    expect(await screen.findByLabelText("Changes in api")).toBeDefined();
    expect(await screen.findByLabelText("Changes in shared-lib")).toBeDefined();
    // Each group carries its own branch — one branch for the whole Task would be a lie.
    const libGroup = await screen.findByLabelText("Changes in shared-lib");
    expect(within(libGroup).getAllByText("feature/lib").length).toBeGreaterThan(0);
    expect(within(libGroup).getByText("src/lib.ts")).toBeDefined();
    const apiGroup = await screen.findByLabelText("Changes in api");
    expect(within(apiGroup).getByText("src/api.ts")).toBeDefined();
    expect(within(apiGroup).queryByText("src/lib.ts")).toBeNull();
  });

  it("shows a single Repository's change with no group header at all", async () => {
    // A single-Repository Task's Changes tab is unchanged by this refactor.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "session.get": () =>
        detailWithDiffs([
          {
            diffRef: "gatecontrol/task-1",
            repositoryId: "repo-1",
            repositoryName: "api",
            ...change("src/api.ts"),
          },
        ]),
    });

    await openChangesTab();

    expect(await screen.findByText("src/api.ts")).toBeDefined();
    expect(screen.queryByLabelText("Changes in api")).toBeNull();
  });

  it("renders a diff captured before Repositories were named as an unlabelled group", async () => {
    // An event written by an older build carries no repository; dropping it would blank the
    // Changes tab of every Task that finished before this change.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "session.get": () =>
        detailWithDiffs([
          { diffRef: "gatecontrol/task-1", ...change("src/legacy.ts") },
          {
            diffRef: "feature/lib",
            repositoryId: "repo-2",
            repositoryName: "shared-lib",
            ...change("src/lib.ts"),
          },
        ]),
    });

    await openChangesTab();

    expect(await screen.findByLabelText("Changes in gatecontrol/task-1")).toBeDefined();
    expect(await screen.findByText("Unnamed repository")).toBeDefined();
    expect(await screen.findByText("src/legacy.ts")).toBeDefined();
  });
});

/**
 * Moving a Task along its lifecycle without leaving the page that holds the evidence.
 *
 * Until this existed the only way to advance a Task was to drag its card on `/board`, so anyone
 * acting on what they had just read had to memorise the verdict and navigate away. What is under
 * test is the wiring rather than the arrows themselves (`task-advance.test.tsx` owns those): that
 * a press reaches `task.move`, that leaving Review asks the board's question first, and that a
 * server refusal arrives as a sentence rather than as the wire code it is sent as.
 */
describe("TaskWorkspace advance control", () => {
  const handlers = (state: TaskDto["state"], over: Handlers = {}): Handlers => ({
    "task.get": () => task({ state }),
    "session.listForTask": () => [session],
    "session.get": () => detail(),
    "stream.ticket": () => ({
      url: "ws://hub.test/?ticket=t",
      expiresAt: "2026-01-01T00:01:00.000Z",
    }),
    ...over,
  });

  it("starts the agent when the step forward is into Running, rather than only writing the state", async () => {
    // `task.move` would be accepted here and would do nothing else: no Session, no launch event.
    // The Task page has no Launch button, so this arrow is how a run begins from it, and a bare
    // move would leave a Task reading Running with no agent behind it — holding a concurrency
    // slot, with no legal way back and `task.launch` refusing it for no longer being Ready.
    const { log } = renderWithTrpc(
      <TaskWorkspace taskId={TASK_ID} />,
      handlers("ready", { "task.launch": () => ({ ok: true }), "task.move": () => ({ ok: true }) }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Move to Running" }));

    await waitFor(() => {
      expect(log.calls.filter((c) => c.path === "task.launch")).toHaveLength(1);
    });
    expect(log.calls.find((c) => c.path === "task.launch")?.input).toEqual({ id: TASK_ID });
    expect(log.calls.filter((c) => c.path === "task.move")).toHaveLength(0);
  });

  it("goes back a column too", async () => {
    const { log } = renderWithTrpc(
      <TaskWorkspace taskId={TASK_ID} />,
      handlers("ready", { "task.move": () => ({ ok: true }) }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Move to Backlog" }));

    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "task.move")?.input).toEqual({
        id: TASK_ID,
        to: "backlog",
      });
    });
  });

  it("asks before moving out of Review, because the proposed changes are abandoned", async () => {
    // The same act as dragging the card off the Review column on the board, so it asks the same
    // question: no review decision is recorded, and the agent's work is left where it stands.
    const { log } = renderWithTrpc(
      <TaskWorkspace taskId={TASK_ID} />,
      handlers("review", { "task.move": () => ({ ok: true }) }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Move to Running" }));
    expect(log.calls.filter((c) => c.path === "task.move")).toHaveLength(0);

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("no review decision is recorded");

    fireEvent.click(screen.getByRole("button", { name: "Move it anyway" }));
    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "task.move")?.input).toEqual({
        id: TASK_ID,
        to: "running",
      });
    });
  });

  it("cancelling that question leaves the Task in Review", async () => {
    const { log } = renderWithTrpc(
      <TaskWorkspace taskId={TASK_ID} />,
      handlers("review", { "task.move": () => ({ ok: true }) }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(log.calls.filter((c) => c.path === "task.move")).toHaveLength(0);
  });

  it("says what a refused move means instead of showing the wire code", async () => {
    // `TASK_ILLEGAL_TRANSITION` on screen tells an Owner nothing they can act on; every refusal
    // goes through `taskActionMessage`, the same mapping the board's banner reads through.
    renderWithTrpc(
      <TaskWorkspace taskId={TASK_ID} />,
      handlers("ready", {
        "task.move": () => {
          throw new Error(TaskErrorCode.IllegalTransition);
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Move to Backlog" }));

    expect(await screen.findByText(/That move isn't allowed/)).toBeDefined();
    expect(screen.queryByText(TaskErrorCode.IllegalTransition)).toBeNull();
  });

  it("says why a refused launch was refused, from the same banner", async () => {
    // The forward arrow now issues `task.launch`, so its refusals have to reach the operator by
    // the same route a move's do — a dependency that is not done is the common one.
    renderWithTrpc(
      <TaskWorkspace taskId={TASK_ID} />,
      handlers("ready", {
        "task.launch": () => {
          throw new Error(TaskDependencyErrorCode.Blocked);
        },
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Move to Running" }));

    expect(await screen.findByText(/waiting on a task that isn't done/)).toBeDefined();
  });

  it("names Approve, not Reject, when the step out of Review is into Done", async () => {
    // The backwards question borrows the board's words; borrowing them forwards would point
    // someone who just asked to mark the task Done at the control for rejecting it. What Done
    // actually skips is the commit, and only Approve performs that.
    renderWithTrpc(
      <TaskWorkspace taskId={TASK_ID} />,
      handlers("review", { "task.move": () => ({ ok: true }) }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Move to Done" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("nothing is committed");
    expect(dialog.textContent).toContain("use Approve below");
    expect(dialog.textContent).not.toContain("use Reject below");
  });
});

/**
 * The agent's todo list beside the diff (the `TodoWrite` capture).
 *
 * A `TodoWrite` used to reach the transcript as a contentless `tool_call` row, so the one artefact
 * that says what the agent thinks it is *going* to do was the one thing the operator could not
 * read. It is now its own event kind, and the panel has to draw it from both of the page's
 * sources — the persisted log for a run reopened later, and the socket for a run in progress,
 * which is the case the panel actually exists for.
 */
describe("TaskWorkspace todo checklist", () => {
  const handlers = (payloads: SessionEventPayload[] = []): Handlers => ({
    "task.get": () => task({ state: "running" }),
    "session.listForTask": () => [session],
    "session.get": () => detail(payloads),
    "stream.ticket": () => ({
      url: "ws://hub.test/?ticket=t",
      expiresAt: "2026-01-01T00:01:00.000Z",
    }),
  });

  const items = [
    { content: "Read the latch code", status: "completed" as const },
    { content: "Write the fix", status: "in_progress" as const, activeForm: "Writing the fix" },
    { content: "Add a regression test", status: "pending" as const },
  ];

  it("draws the list a finished run left behind", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers([{ kind: "todos", items }]));

    const plan = await screen.findByRole("region", { name: "Agent plan" });
    expect(within(plan).getByText("Read the latch code")).toBeDefined();
    // The live item is shown in the present tense the agent wrote for exactly this moment.
    expect(within(plan).getByText("Writing the fix")).toBeDefined();
    expect(within(plan).getByText("1 of 3 done")).toBeDefined();
  });

  it("shows no panel at all until the agent has published a plan", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers());

    await screen.findByRole("complementary", { name: "Changes" });
    expect(screen.queryByRole("region", { name: "Agent plan" })).toBeNull();
  });

  it("follows the run: a list published mid-run lands without a reload", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers([{ kind: "todos", items }]));
    await screen.findByText("1 of 3 done");
    await waitFor(() => expect(sockets[0]).toBeDefined());

    act(() =>
      sockets[0]?.emit({
        kind: "todos",
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        seq: 7,
        items: [
          { content: "Read the latch code", status: "completed" },
          { content: "Write the fix", status: "completed" },
          { content: "Add a regression test", status: "in_progress", activeForm: "Adding a test" },
        ],
      }),
    );

    // The whole list is republished on every write, so the newer one replaces the older outright
    // rather than merging into it — which is why the count moves and "Writing the fix" is gone.
    expect(await screen.findByText("2 of 3 done")).toBeDefined();
    expect(await screen.findByText("Adding a test")).toBeDefined();
    expect(screen.queryByText("Writing the fix")).toBeNull();
  });
});
