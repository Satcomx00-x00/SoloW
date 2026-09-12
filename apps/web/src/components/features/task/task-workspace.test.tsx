/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  type SessionEventPayload,
  TaskDependencyErrorCode,
  type TaskDto,
  TaskErrorCode,
} from "@solow/contracts";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  type CallLog,
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
 * that the controls lock while a decision is in flight (no double-approve), and that harness
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
    agentProfileId: "harness-1",
    executorProfileId: "exec-1",
    repositories: [
      {
        id: "attach-1",
        repositoryId: "repo-1",
        baseRef: "main",
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
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const session = {
  id: SESSION_ID,
  taskId: TASK_ID,
  state: "awaiting_review" as const,
  diffRef: "solow/task-1",
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
    rounds: [],
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

  it("requests changes without requiring feedback first", async () => {
    // The gate used to hold a Textarea and refuse to submit until it had something in it, which
    // made "request changes" the one review action that could not be taken by pressing it. The
    // contract dropped the requirement (`reviewDecisionInput` no longer refines on it). The
    // remark box is back — optional — and the button is live on arrival like Approve and Reject.
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

    fireEvent.click(request);
    await waitFor(() => {
      expect(log.calls.filter((c) => c.path === "review.decide")).toHaveLength(1);
    });
    // Nothing invents a feedback string on the way out — the harness resumes on the original brief.
    expect(log.calls.find((c) => c.path === "review.decide")?.input).toEqual({
      sessionId: SESSION_ID,
      decision: "request_changes",
    });
  });

  it("sends the reviewer's notes and remark as the decision's feedback, on request changes only", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task(),
      "session.listForTask": () => [session],
      "session.get": () => ({
        ...detail(),
        diffs: [
          {
            diffRef: "solow/task-1",
            repositoryId: "repo-1",
            repositoryName: "api",
            files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
            patch: [
              "diff --git a/src/a.ts b/src/a.ts",
              "@@ -1,2 +1,2 @@",
              " const a = 1;",
              "-const b = 2;",
              "+const b = 3;",
              "",
            ].join("\n"),
            truncated: false,
          },
        ],
        rounds: [{ index: 1, closedAtSeq: null, diffs: [], review: null }],
      }),
      "preference.getReviewDraft": () => ({
        workspaceId: "ws",
        userId: "u",
        taskId: TASK_ID,
        draft: null,
      }),
      "preference.setReviewDraft": (input: unknown) => ({
        workspaceId: "ws",
        userId: "u",
        taskId: TASK_ID,
        draft: (input as { draft: unknown }).draft,
      }),
      "preference.clearReviewDraft": () => ({
        workspaceId: "ws",
        userId: "u",
        taskId: TASK_ID,
        draft: null,
      }),
      "review.decide": () => ({ ok: true }),
    });

    // A note on a line of the diff, taken where the line is.
    fireEvent.click(await screen.findByRole("button", { name: "Add a note on line 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), {
      target: { value: "why 3?" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText(/1 note/)).toBeDefined();
    // And a remark about the change as a whole, at the gate.
    fireEvent.change(screen.getByRole("textbox", { name: "Feedback for the harness" }), {
      target: { value: "Close, but check the config." },
    });

    fireEvent.click(screen.getByRole("button", { name: /Request changes/ }));
    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === "review.decide")).toHaveLength(1),
    );
    const input = log.calls.find((c) => c.path === "review.decide")?.input as { feedback?: string };
    expect(input.feedback).toBe(
      "Close, but check the config.\n\nNotes on specific lines:\n- src/a.ts:2 — why 3?",
    );
    // The draft is spent with the decision.
    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === "preference.clearReviewDraft")).toHaveLength(1),
    );
  });

  it("offers Open review on a Workflow Step that finished with nothing to do — the plan is what is reviewed", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () =>
        task({
          state: "running",
          workflowId: "wf-1",
          workflowStepId: "st-1",
          completedAt: "2026-01-01T00:00:00.000Z",
          completedOutcome: "nothing_to_do",
          completedSummary: "Wrote the plan; changed no file, per the brief.",
        }),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "task.submitForReview": () => task({ state: "review" }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open review" }));
    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === "task.submitForReview")).toHaveLength(1),
    );
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

    // The foot still says something — what the harness is doing — but offers no decision.
    expect(await screen.findByText(/The harness is working/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });

  it("offers Retry on a failed run, from the page that shows the failure", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state: "failed", failureReason: "interrupted" }),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "task.retry": () => task({ state: "running" }),
    });

    expect(await screen.findByText("Interrupted by restart")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(log.calls.filter((c) => c.path === "task.retry")).toHaveLength(1);
    });
    expect(log.calls.find((c) => c.path === "task.retry")?.input).toEqual({ id: TASK_ID });
  });

  it("says why a refused retry was refused, in words, under the control", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state: "failed", failureReason: "fail" }),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "task.retry": () => {
        throw new Error(TaskErrorCode.ConcurrencyCapReached);
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain(TaskErrorCode.ConcurrencyCapReached);
    expect(alert.textContent?.length ?? 0).toBeGreaterThan(20);
  });

  it("renders recorded harness output in the terminal panel", async () => {
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

describe("TaskWorkspace dependencies (issue #6)", () => {
  const edges = [
    {
      taskId: TASK_ID,
      blockedByTaskId: "task-0",
      blockedByTitle: "Pour the foundation",
      blockedByState: "running" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      taskId: "task-9",
      blockedByTaskId: TASK_ID,
      blockedByTitle: "Fix the gate latch",
      blockedByState: "ready" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];

  it("names what this task waits on and what waits on it, each a link to the other task", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state: "ready" }),
      "session.listForTask": () => [],
      "task.dependencies": () => edges,
      "task.list": () => ({
        items: [task({ id: "task-9", title: "Hang the gate", state: "backlog" })],
        nextCursor: null,
      }),
    });

    const blocker = await screen.findByRole("link", { name: /Pour the foundation/ });
    expect(blocker.getAttribute("href")).toBe("/task/task-0");
    const dependant = await screen.findByRole("link", { name: /Hang the gate/ });
    expect(dependant.getAttribute("href")).toBe("/task/task-9");
    // Launch is refused here, in words, rather than after a round trip as a wire code.
    expect(screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Waiting on Pour the foundation \(Running\)/)).toBeDefined();
  });

  it("shows no dependency row at all on a task with no edges", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state: "ready" }),
      "session.listForTask": () => [],
      "task.dependencies": () => [],
    });

    expect(await screen.findByRole("button", { name: "Launch" })).toBeDefined();
    expect(document.querySelector("[data-task-dependencies]")).toBeNull();
    expect(screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("TaskWorkspace meta popover", () => {
  it("names the profiles behind the ids, the base ref and the session, on demand", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state: "review" }),
      "session.listForTask": () => [session],
      "session.get": () => detail(),
      "profile.agent.list": () => ({
        items: [{ id: "harness-1", secretId: "secret-1", name: "Claude", agentCatalogId: "cat-1" }],
        nextCursor: null,
      }),
      "profile.executor.list": () => ({
        items: [{ id: "exec-1", name: "This machine", kind: "local", config: {} }],
        nextCursor: null,
      }),
    });

    const about = await screen.findByRole("button", { name: "About this task" });
    // Nothing is fetched for a popover nobody opened.
    expect(log.calls.some((c) => c.path === "profile.agent.list")).toBe(false);
    fireEvent.click(about);

    expect(await screen.findByText("Claude")).toBeDefined();
    expect(await screen.findByText("This machine")).toBeDefined();
    expect(screen.getByText(/from main/)).toBeDefined();
    expect(screen.getByRole("button", { name: `Copy ${SESSION_ID}` })).toBeDefined();
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

describe("TaskWorkspace harness steering (TASK-022)", () => {
  const handlers = (state: TaskDto["state"]) => ({
    "task.get": () => task({ state }),
    "session.listForTask": () => [session],
    "session.get": () => detail(),
    "stream.ticket": () => ({
      url: "ws://hub.test/?ticket=t",
      expiresAt: "2026-01-01T00:01:00.000Z",
    }),
  });

  it("sends what the operator typed to the running harness, then clears the box", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("running"));
    const box = (await screen.findByLabelText(/Message the harness/)) as HTMLInputElement;
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
    // (Principle I) — a back channel into the harness would bypass that.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("review"));
    const box = await screen.findByLabelText(/Message the harness/);
    expect(box.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Send/ }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: /Stop/ }).hasAttribute("disabled")).toBe(true);
  });

  it("confirms before stopping the harness, then sends the stop", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("running"));
    const stop = await screen.findByRole("button", { name: /Stop/ });
    await waitFor(() => expect(stop.hasAttribute("disabled")).toBe(false));

    fireEvent.click(stop);
    expect(sockets[0]?.sent).toEqual([]);
    expect(await screen.findByRole("alertdialog")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Stop the harness/ }));
    await waitFor(() => expect(sockets[0]?.sent).toEqual([{ kind: "stop", taskId: TASK_ID }]));
  });

  it("holds a message typed while the stream is away, and sends it once the stream is back", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("running"));
    const box = (await screen.findByLabelText(/Message the harness/)) as HTMLTextAreaElement;
    await waitFor(() => expect(box.hasAttribute("disabled")).toBe(false));
    await waitFor(() =>
      expect(
        document.querySelector("[data-stream-status]")?.getAttribute("data-stream-status"),
      ).toBe("open"),
    );

    // The hub goes away. The box stays open; the message is held, not dropped.
    act(() => sockets[0]?.drop());
    await waitFor(() =>
      expect(
        document.querySelector("[data-stream-status]")?.getAttribute("data-stream-status"),
      ).not.toBe("open"),
    );
    expect(box.hasAttribute("disabled")).toBe(false);
    fireEvent.change(box, { target: { value: "also bump the version" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    expect(await screen.findByText(/Queued — sends when the stream is back/)).toBeDefined();
    expect(box.value).toBe("");
    expect(sockets[0]?.sent).toEqual([]);

    // The hub is back (the hook reconnects on its own): the held message goes, once.
    await waitFor(() => expect(sockets.length).toBe(2), { timeout: 3000 });
    await waitFor(() =>
      expect(sockets[1]?.sent).toEqual([
        { kind: "input", taskId: TASK_ID, data: "also bump the version" },
      ]),
    );
    await waitFor(() => expect(screen.queryByText(/Queued — sends/)).toBeNull());
  });

  it("tells the operator when the hub had no harness to give the input to", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers("running"));
    const box = (await screen.findByLabelText(/Message the harness/)) as HTMLInputElement;
    await waitFor(() => expect(box.hasAttribute("disabled")).toBe(false));

    fireEvent.change(box, { target: { value: "are you there?" } });
    fireEvent.click(screen.getByRole("button", { name: /Send/ }));
    await waitFor(() => expect(sockets[0]?.sent).toHaveLength(1));

    // Silently swallowing this would leave the operator believing the harness got the message.
    act(() => sockets[0]?.emit({ kind: "ack", ok: false, error: "agent_not_running" }));
    expect(await screen.findByText(/No harness is running/)).toBeDefined();
  });
});

/**
 * A harness asking for permission, from the operator's chair (issue #58, AC-4). The frame goes
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
    await screen.findByRole("complementary", { name: "Review" });
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
            diffRef: "solow/task-1",
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

    // The label names `(repository, branch)`, which is what a group *is* (issue #70 AC-1) — a
    // repository attached twice on two branches would otherwise give two groups one name.
    expect(await screen.findByLabelText("Changes in api on solow/task-1")).toBeDefined();
    expect(await screen.findByLabelText("Changes in shared-lib on feature/lib")).toBeDefined();
    // Each group carries its own branch — one branch for the whole Task would be a lie.
    const libGroup = await screen.findByLabelText("Changes in shared-lib on feature/lib");
    expect(within(libGroup).getAllByText("feature/lib").length).toBeGreaterThan(0);
    expect(
      within(within(libGroup).getByRole("list", { name: "Changes" })).getByTitle("src/lib.ts"),
    ).toBeDefined();
    const apiGroup = await screen.findByLabelText("Changes in api on solow/task-1");
    const apiFiles = within(apiGroup).getByRole("list", { name: "Changes" });
    expect(within(apiFiles).getByTitle("src/api.ts")).toBeDefined();
    expect(within(apiFiles).queryByTitle("src/lib.ts")).toBeNull();
  });

  it("states the size of the change and flags what is easy to miss in a long list", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "task.get": () =>
        task({
          repositories: [
            {
              id: "attach-1",
              repositoryId: "repo-1",
              baseRef: "main",
              checkoutBranch: "solow/task-1",
              resultBranch: "solow/task-1",
              position: 0,
            },
            {
              id: "attach-2",
              repositoryId: "repo-2",
              baseRef: "main",
              checkoutBranch: "solow/task-1",
              resultBranch: "feature/lib",
              position: 1,
            },
          ],
        }),
      "session.get": () =>
        detailWithDiffs([
          {
            diffRef: "solow/task-1",
            repositoryId: "repo-1",
            repositoryName: "api",
            files: [
              { path: "src/api.ts", status: "modified", additions: 40, deletions: 5 },
              { path: "src/legacy.ts", status: "deleted", additions: 0, deletions: 200 },
              { path: "bun.lock", status: "modified", additions: 300, deletions: 300 },
            ],
            patch: "--- a/src/api.ts\n+++ b/src/api.ts\n",
            truncated: true,
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
    const api = await screen.findByLabelText("Changes in api on solow/task-1");
    expect(within(api).getByText("3 files")).toBeDefined();
    expect(within(api).getByText("+340")).toBeDefined();
    expect(within(api).getByText("−505")).toBeDefined();
    expect(within(api).getByText(/Patch cut short/)).toBeDefined();
    expect(within(api).getByText(/Deletes src\/legacy.ts/)).toBeDefined();
    expect(within(api).getByText(/Lockfile changed: bun.lock/)).toBeDefined();
    // The second repository changed too, and that is said once at the top, not discovered below.
    expect(screen.getByText(/Changes outside the primary repository: shared-lib/)).toBeDefined();
    // And the gate's one line now carries the weight as well as the count.
    expect(screen.getByText(/Approving covers .*4 files, \+342 −506/)).toBeDefined();
  });

  it("walks back through the review rounds, read-only, with what was decided on each", async () => {
    const round = (index: number, path: string, review: unknown, closedAtSeq: number | null) => ({
      index,
      closedAtSeq,
      diffs: [
        { diffRef: "solow/task-1", repositoryId: "repo-1", repositoryName: "api", ...change(path) },
      ],
      review,
    });
    const decided = {
      id: "rev-1",
      sessionId: SESSION_ID,
      decision: "request_changes",
      feedback: "the other config file",
      actorUserId: "u",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "session.get": () => ({
        ...detailWithDiffs([
          {
            diffRef: "solow/task-1",
            repositoryId: "repo-1",
            repositoryName: "api",
            ...change("src/v2.ts"),
          },
        ]),
        rounds: [round(1, "src/v1.ts", decided, 7), round(2, "src/v2.ts", null, null)],
      }),
    });

    await openChangesTab();
    // The latest round by default, which is the one the gate is about.
    expect(await screen.findByText("Round 2 of 2")).toBeDefined();
    const files = () => screen.getByRole("list", { name: "Changes" });
    expect(within(files()).getByTitle("src/v2.ts")).toBeDefined();
    expect(screen.getByRole("button", { name: "Next round" }).hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Previous round" }));
    expect(screen.getByText("Round 1 of 2")).toBeDefined();
    expect(within(files()).getByTitle("src/v1.ts")).toBeDefined();
    expect(within(files()).queryByTitle("src/v2.ts")).toBeNull();
    expect(screen.getByText(/Superseded — read-only/)).toBeDefined();
    // What the reviewer said then — the part a new round used to lose.
    expect(screen.getByText("Changes requested")).toBeDefined();
    expect(screen.getByText("the other config file")).toBeDefined();
    // The gate still speaks of the latest round, whatever the tab shows.
    expect(screen.getByRole("button", { name: /Approve/ })).toBeDefined();
  });

  it("offers earlier launches when a Retry opened a second Session, and reads the one picked", async () => {
    const older = {
      ...session,
      id: "sess-0",
      state: "closed" as const,
      startedAt: "2025-12-31T00:00:00.000Z",
      endedAt: "2025-12-31T01:00:00.000Z",
    };
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "session.listForTask": () => [session, older],
      "session.get": (input: unknown) =>
        (input as { sessionId: string }).sessionId === older.id
          ? {
              ...detail([{ kind: "assistant_turn", text: "first attempt", thinking: false }]),
              session: older,
            }
          : detail([{ kind: "assistant_turn", text: "second attempt", thinking: false }]),
    });

    expect(await screen.findByText(/second attempt/)).toBeDefined();
    const picker = screen.getByRole("combobox", { name: "Launch" });
    fireEvent.change(picker, { target: { value: older.id } });
    expect(await screen.findByText(/first attempt/)).toBeDefined();
    expect(log.calls.filter((c) => c.path === "session.get").at(-1)?.input).toMatchObject({
      sessionId: older.id,
    });
  });

  it("lets the reviewer tick files off as read, counts them at the gate, and remembers per round", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "session.get": () => ({
        ...detailWithDiffs([
          {
            diffRef: "solow/task-1",
            repositoryId: "repo-1",
            repositoryName: "api",
            files: [
              { path: "src/a.ts", status: "modified", additions: 1, deletions: 0 },
              { path: "src/b.ts", status: "modified", additions: 1, deletions: 0 },
            ],
            patch: "--- a/src/a.ts\n+++ b/src/a.ts\n",
            truncated: false,
          },
        ]),
        rounds: [{ index: 3, closedAtSeq: null, diffs: [], review: null }],
      }),
      // A draft from the round before: stale, so it must not count.
      "preference.getReviewDraft": () => ({
        workspaceId: "ws",
        userId: "u",
        taskId: TASK_ID,
        draft: {
          sessionId: SESSION_ID,
          round: 2,
          viewed: [{ repositoryId: "repo-1", path: "src/a.ts" }],
          notes: [],
          general: "",
        },
      }),
      "preference.setReviewDraft": (input: unknown) => ({
        workspaceId: "ws",
        userId: "u",
        taskId: TASK_ID,
        draft: (input as { draft: unknown }).draft,
      }),
    });

    await openChangesTab();
    expect(await screen.findByText(/0 of 2 files viewed/)).toBeDefined();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Mark src/a.ts viewed" }));
    expect(await screen.findByText(/1 of 2 files viewed/)).toBeDefined();
    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === "preference.setReviewDraft")).toHaveLength(1),
    );
    // Written against the round on screen, so the next round starts clean.
    expect(log.calls.find((c) => c.path === "preference.setReviewDraft")?.input).toMatchObject({
      taskId: TASK_ID,
      draft: {
        sessionId: SESSION_ID,
        round: 3,
        viewed: [{ repositoryId: "repo-1", path: "src/a.ts" }],
      },
    });
    // Never a gate: Approve is still just Approve.
    expect(screen.getByRole("button", { name: "Approve" }).hasAttribute("disabled")).toBe(false);
  });

  it("shows a single Repository's change with no group header at all", async () => {
    // A single-Repository Task's Changes tab is unchanged by this refactor.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "session.get": () =>
        detailWithDiffs([
          {
            diffRef: "solow/task-1",
            repositoryId: "repo-1",
            repositoryName: "api",
            ...change("src/api.ts"),
          },
        ]),
    });

    await openChangesTab();

    expect(
      within(await screen.findByRole("list", { name: "Changes" })).getByTitle("src/api.ts"),
    ).toBeDefined();
    expect(screen.queryByLabelText("Changes in api on solow/task-1")).toBeNull();
  });

  it("renders a diff captured before Repositories were named as an unlabelled group", async () => {
    // An event written by an older build carries no repository; dropping it would blank the
    // Changes tab of every Task that finished before this change.
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...baseHandlers,
      "session.get": () =>
        detailWithDiffs([
          { diffRef: "solow/task-1", ...change("src/legacy.ts") },
          {
            diffRef: "feature/lib",
            repositoryId: "repo-2",
            repositoryName: "shared-lib",
            ...change("src/lib.ts"),
          },
        ]),
    });

    await openChangesTab();

    const label = "Changes in an unnamed repository on solow/task-1";
    expect(await screen.findByLabelText(label)).toBeDefined();
    expect(await screen.findByText("Unnamed repository")).toBeDefined();
    const unnamed = await screen.findByLabelText(label);
    expect(
      within(within(unnamed).getByRole("list", { name: "Changes" })).getByTitle("src/legacy.ts"),
    ).toBeDefined();
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

  it("starts the harness when the step forward is into Running, rather than only writing the state", async () => {
    // `task.move` would be accepted here and would do nothing else: no Session, no launch event.
    // The Task page has no Launch button, so this arrow is how a run begins from it, and a bare
    // move would leave a Task reading Running with no harness behind it — holding a concurrency
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
    // question: no review decision is recorded, and the harness's work is left where it stands.
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
 * The harness's todo list beside the diff (the `TodoWrite` capture).
 *
 * A `TodoWrite` used to reach the transcript as a contentless `tool_call` row, so the one artefact
 * that says what the harness thinks it is *going* to do was the one thing the operator could not
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

    const plan = await screen.findByRole("region", { name: "Harness plan" });
    expect(within(plan).getByText("Read the latch code")).toBeDefined();
    // The live item is shown in the present tense the harness wrote for exactly this moment.
    expect(within(plan).getByText("Writing the fix")).toBeDefined();
    expect(within(plan).getByText("1 of 3 done")).toBeDefined();
  });

  it("shows a step_card plan on the Plan tab when the harness published no todo list", async () => {
    // A plan-first Step typically publishes its plan as a `step_card` widget and nothing else;
    // a Plan tab that only read `todos` sat disabled beside a transcript containing the plan.
    renderWithTrpc(
      <TaskWorkspace taskId={TASK_ID} />,
      handlers([
        {
          kind: "widget",
          widgetId: "w-1",
          widget: {
            kind: "step_card",
            title: "Plan: fix the latch",
            steps: [
              { id: "study", label: "Study the latch code", state: "done" },
              { id: "write", label: "Write the fix", state: "active" },
            ],
          },
        },
      ]),
    );

    const plan = await screen.findByRole("region", { name: "Harness plan" });
    expect(within(plan).getByText("Plan: fix the latch")).toBeDefined();
    expect(within(plan).getByText("Write the fix")).toBeDefined();
    expect(screen.getByRole("tab", { name: /Plan/ }).hasAttribute("disabled")).toBe(false);
  });

  it("shows no panel at all until the harness has published a plan", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, handlers());

    await screen.findByRole("complementary", { name: "Review" });
    expect(screen.queryByRole("region", { name: "Harness plan" })).toBeNull();
    // And the tab that would show it is there but disabled — never a heading over nothing.
    expect(screen.getByRole("tab", { name: "Plan" }).hasAttribute("disabled")).toBe(true);
  });

  it("opens on the plan while the run is going, and on the change once one is captured", async () => {
    let state: TaskDto["state"] = "running";
    const diff: SessionEventPayload = {
      kind: "diff",
      diffRef: "solow/task-1",
      files: [{ path: "src/latch.ts", status: "modified", additions: 3, deletions: 1 }],
      patch: "diff --git a/src/latch.ts b/src/latch.ts\n",
      truncated: false,
    };
    let payloads: SessionEventPayload[] = [{ kind: "todos", items }];
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state }),
      "session.listForTask": () => [session],
      "session.get": () => detail(payloads),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
    });

    const plan = await screen.findByRole("tab", { name: /Plan/ });
    await waitFor(() => expect(plan.getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByRole("region", { name: "Harness plan" })).toBeDefined();

    // The reviewer's pick wins over the default, until the Task moves on.
    fireEvent.click(screen.getByRole("tab", { name: /Changes/ }));
    expect(screen.getByRole("tab", { name: /Changes/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(plan);
    expect(plan.getAttribute("aria-selected")).toBe("true");

    // The run reaches its gate: the diff lands and the column turns to it.
    state = "review";
    payloads = [...payloads, diff];
    await waitFor(() => expect(sockets[0]).toBeDefined());
    act(() =>
      sockets[0]?.emit({
        kind: "status",
        taskId: TASK_ID,
        state: "review",
        at: "2026-01-01T00:00:00.000Z",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Changes/ }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
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

/**
 * The page following its own Task's state, without a reload.
 *
 * The report: "the Writing animation is still happening when I stay on the page, but disappears
 * when reloading." True, and the cause was one line in the orchestrator — a state change was
 * announced on the Workspace board channel alone, so the board updated instantly and the page
 * dedicated to that very Task never heard it. Everything this page derives from the Task's state
 * was therefore correct only on a fresh load: the activity line, the review gate, and whether the
 * composer would still offer to steer a harness that had already stopped.
 *
 * One test, because they are one fact: the Task's own channel now carries the status, and this
 * page acts on it. The review gate is the assertion because it is the consequence an operator is
 * actually waiting for.
 */
describe("TaskWorkspace live state", () => {
  it("opens the review gate on a status event, with no reload", async () => {
    // `task.get` answers differently after the run ends, exactly as the server's does.
    let state = "running";
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state: state as "running" }),
      "session.listForTask": () => [session],
      "session.get": () =>
        detail([{ kind: "assistant_turn", text: "still going", thinking: false }]),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
    });

    await screen.findByText("still going");
    await waitFor(() => expect(sockets[0]).toBeDefined());
    // Nothing to decide while it runs.
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();

    state = "review";
    act(() =>
      sockets[0]?.emit({
        kind: "status",
        taskId: TASK_ID,
        state: "review",
        at: "2026-01-01T00:00:05.000Z",
      }),
    );

    expect(await screen.findByRole("button", { name: /Approve/ })).toBeDefined();
  });
});

/** Where the Task is in its Workflow, in the header (spec F03). */
describe("TaskWorkspace workflow steps", () => {
  const step = (id: string, name: string, position: number) => ({
    id,
    workflowId: "wf-1",
    name,
    position,
    rank: `r${position}`,
    agentProfileId: "harness-1",
    promptTemplate: "Do it.",
    gate: "human" as const,
    advanceOn: "review" as const,
    onEnter: null,
    branch: null,
    mcpServerIds: [],
    skillIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const steps = [step("st-1", "Implement", 0), step("st-2", "Review", 1), step("st-3", "Ship", 2)];
  const binding = (current: string) => ({
    taskId: TASK_ID,
    workflowId: "wf-1",
    workflowName: "Implement & review",
    attachedVersion: 1,
    currentVersion: 1,
    definitionDrifted: false,
    currentStep: steps.find((s) => s.id === current),
    steps,
    handoff: null,
    brief: "Do it.",
  });
  const base: Handlers = {
    "session.listForTask": () => [session],
    "session.get": () => detail(),
    "stream.ticket": () => ({
      url: "ws://hub.test/?ticket=t",
      expiresAt: "2026-01-01T00:01:00.000Z",
    }),
  };

  it("names the current Step, with the ones before it done and the ones after still to come", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...base,
      "task.get": () => task({ state: "running", workflowId: "wf-1", workflowStepId: "st-2" }),
      "workflow.taskBinding": () => binding("st-2"),
    });

    const strip = await screen.findByRole("region", { name: "Workflow progress" });
    expect(strip.textContent).toContain("Implement & review");
    expect(strip.textContent).toContain("Step 2 of 3");
    // The steps are the strip's tabs now — the `<li>`s stepped aside (role="presentation") so the
    // tablist could own its tabs directly, which takes them out of the listitem role they used to
    // be found by. The status still rides on the same element; it is read off the slot instead.
    const items = Array.from(strip.querySelectorAll("[data-slot='step']"));
    expect(items.map((li) => li.getAttribute("data-status"))).toEqual([
      "done",
      "running",
      "upcoming",
    ]);
    // `aria-current` still means one thing only: this is where the run is. It rides on the tab
    // rather than on the presentational `<li>`, which is out of the accessibility tree.
    const tabs = within(strip).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("aria-current"))).toEqual([null, null, "step", null]);
  });

  it("marks the last Step done once the Task is, rather than leaving it current forever", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...base,
      "task.get": () => task({ state: "done", workflowId: "wf-1", workflowStepId: "st-3" }),
      "workflow.taskBinding": () => binding("st-3"),
    });

    const strip = await screen.findByRole("region", { name: "Workflow progress" });
    const items = Array.from(strip.querySelectorAll("[data-slot='step']"));
    expect(items.map((li) => li.getAttribute("data-status"))).toEqual(["done", "done", "done"]);
  });

  it("shows nothing for a Task on no Workflow, and never asks for its binding", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...base,
      "task.get": () => task(),
    });

    await screen.findByText(/Review actions become available|Approve/);
    expect(screen.queryByRole("region", { name: "Workflow progress" })).toBeNull();
    expect(log.calls.some((c) => c.path === "workflow.taskBinding")).toBe(false);
  });
});

/**
 * One Step in the terminal at a time (the user's report: "all the step harness content in the
 * same terminal ... causing terminal interface loading problems").
 *
 * A Session spans the whole pipeline, so the fix is a narrowing that reaches the *server* — the
 * assertions below are mostly about what was asked for, not what was rendered, because filtering
 * on arrival would still transfer and hold every Step's output and fix nothing. The rendering
 * assertions cover the other half: frames that arrive after the query ran have to obey the same
 * scope, and the frames that carry no Step at all have to survive it.
 */
describe("TaskWorkspace step-scoped terminal", () => {
  const step = (id: string, name: string, position: number) => ({
    id,
    workflowId: "wf-1",
    name,
    position,
    rank: `r${position}`,
    agentProfileId: "harness-1",
    promptTemplate: "Do it.",
    gate: "human" as const,
    advanceOn: "review" as const,
    onEnter: null,
    branch: null,
    mcpServerIds: [],
    skillIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const steps = [step("st-1", "Implement", 0), step("st-2", "Review", 1), step("st-3", "Ship", 2)];
  const binding = (current: string) => ({
    taskId: TASK_ID,
    workflowId: "wf-1",
    workflowName: "Implement & review",
    attachedVersion: 1,
    currentVersion: 1,
    definitionDrifted: false,
    currentStep: steps.find((s) => s.id === current),
    steps,
    handoff: null,
    brief: "Do it.",
  });

  /** A bound Task sitting on `current`, with an empty log — the queries are what is under test. */
  const bound = (current: string, over: Handlers = {}): Handlers => ({
    "task.get": () => task({ state: "running", workflowId: "wf-1", workflowStepId: current }),
    "workflow.taskBinding": () => binding(current),
    "session.listForTask": () => [session],
    "session.get": () => detail(),
    "stream.ticket": () => ({
      url: "ws://hub.test/?ticket=t",
      expiresAt: "2026-01-01T00:01:00.000Z",
    }),
    ...over,
  });

  const sessionGets = (log: CallLog) => log.calls.filter((c) => c.path === "session.get");

  it("opens on the Step the run is on, and asks for only that Step's log", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, bound("st-2"));

    await screen.findByRole("region", { name: "Workflow progress" });
    await waitFor(() => expect(sessionGets(log).length).toBeGreaterThan(0));
    // Every request, not just the last: a first unscoped fetch superseded a moment later would
    // pull the whole pipeline over the wire once per page load, which is the cost being removed.
    for (const call of sessionGets(log)) {
      expect(call.input).toEqual({ sessionId: SESSION_ID, workflowStepId: "st-2" });
    }
  });

  it("says which Step it is showing, so a short transcript is not read as a short run", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, bound("st-2"));

    // The terminal's panel, not the right column's — that has tabs of its own now.
    const strip = await screen.findByRole("region", { name: "Workflow progress" });
    const panelId = within(strip)
      .getByRole("tab", { name: /Review/ })
      .getAttribute("aria-controls");
    const panel = document.getElementById(panelId ?? "") as HTMLElement;
    expect(panel.textContent).toContain("Showing");
    expect(panel.textContent).toContain("step 2 of 3");
    expect(panel.textContent).toContain("The rest of this run is under the other steps.");
  });

  it("re-asks the server, scoped, when a Step is clicked", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, bound("st-2"));

    fireEvent.click(await screen.findByRole("tab", { name: /Implement/ }));

    await waitFor(() =>
      expect(sessionGets(log).at(-1)?.input).toEqual({
        sessionId: SESSION_ID,
        workflowStepId: "st-1",
      }),
    );
    // The tab that is selected and the tab the run is on are two different tabs now, and each
    // says so in its own attribute.
    const implement = screen.getByRole("tab", { name: /Implement/ });
    expect(implement.getAttribute("aria-selected")).toBe("true");
    expect(implement.getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("tab", { name: /Review/ }).getAttribute("aria-current")).toBe("step");
  });

  it("asks for the whole run again, in the words it always used, when told to", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, bound("st-2"));

    fireEvent.click(await screen.findByRole("tab", { name: "Whole run" }));

    // No `workflowStepId` key at all, not a null one: the unscoped request has to stay the exact
    // request this page made before any of this existed.
    await waitFor(() => expect(sessionGets(log).at(-1)?.input).toEqual({ sessionId: SESSION_ID }));
    // ...and with nothing narrowed, the terminal stops claiming it is narrowed.
    await waitFor(() => expect(screen.queryByText(/The rest of this run/)).toBeNull());
  });

  it("follows the run as it advances — until the operator picks a Step, after which it stays put", async () => {
    let current = "st-1";
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      ...bound("st-1"),
      "task.get": () =>
        task({ state: "running", workflowId: "wf-1", workflowStepId: current as string }),
      "workflow.taskBinding": () => binding(current),
    });

    await waitFor(() =>
      expect(sessionGets(log).at(-1)?.input).toEqual({
        sessionId: SESSION_ID,
        workflowStepId: "st-1",
      }),
    );
    await waitFor(() => expect(sockets[0]).toBeDefined());

    // A Step advancing announces the Task's state, which is what re-reads the binding.
    current = "st-2";
    act(() =>
      sockets[0]?.emit({
        kind: "status",
        taskId: TASK_ID,
        state: "running",
        at: "2026-01-01T00:00:05.000Z",
      }),
    );
    await waitFor(() =>
      expect(sessionGets(log).at(-1)?.input).toEqual({
        sessionId: SESSION_ID,
        workflowStepId: "st-2",
      }),
    );

    // Now the operator chooses. From here the run may go where it likes; the screen does not.
    fireEvent.click(await screen.findByRole("tab", { name: /Implement/ }));
    await waitFor(() =>
      expect(sessionGets(log).at(-1)?.input).toEqual({
        sessionId: SESSION_ID,
        workflowStepId: "st-1",
      }),
    );

    current = "st-3";
    act(() =>
      sockets[0]?.emit({
        kind: "status",
        taskId: TASK_ID,
        state: "running",
        at: "2026-01-01T00:00:09.000Z",
      }),
    );
    await screen.findByRole("tab", { name: /Ship/ });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Ship/ }).getAttribute("aria-current")).toBe("step"),
    );
    // The cursor moved twice and the terminal is still on the Step that was asked for.
    expect(screen.getByRole("tab", { name: /Implement/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(sessionGets(log).at(-1)?.input).toEqual({
      sessionId: SESSION_ID,
      workflowStepId: "st-1",
    });
  });

  it("keeps another Step's live output out, and everything unattributed in", async () => {
    renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, bound("st-2"));
    await screen.findByRole("region", { name: "Workflow progress" });
    await waitFor(() => expect(sockets[0]).toBeDefined());

    const line = (seq: number, text: string, workflowStepId?: string | null) => ({
      kind: "stdout",
      taskId: TASK_ID,
      sessionId: SESSION_ID,
      seq,
      text,
      channel: "assistant",
      ...(workflowStepId === undefined ? {} : { workflowStepId }),
    });

    act(() => {
      sockets[0]?.emit(line(1, "belongs to the review step", "st-2"));
      sockets[0]?.emit(line(2, "belongs to the implement step", "st-1"));
      // Null and absent are the same answer — unattributed — and neither is a Step to filter to.
      // An orchestrator older than the column sends the second; a Task on no Workflow, the first.
      sockets[0]?.emit(line(3, "written before Steps were recorded", null));
      sockets[0]?.emit(line(4, "from a producer that never heard of Steps"));
    });

    expect(await screen.findByText(/belongs to the review step/)).toBeDefined();
    expect(await screen.findByText(/written before Steps were recorded/)).toBeDefined();
    expect(await screen.findByText(/from a producer that never heard of Steps/)).toBeDefined();
    expect(screen.queryByText(/belongs to the implement step/)).toBeNull();
  });

  it("is operable from the keyboard, one tab stop for the whole strip", async () => {
    // A strip of a dozen steps that each swallowed a Tab press would put the terminal below it a
    // dozen presses away, so the tabs share one stop and the arrows walk them (WAI-ARIA APG).
    // Activation is manual — arrowing to a Step must not fire a query for it on the way past.
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, bound("st-2"));

    const strip = await screen.findByRole("region", { name: "Workflow progress" });
    const review = within(strip).getByRole("tab", { name: /Review/ });
    const tabs = within(strip).getAllByRole("tab");
    // Exactly one of them is reachable by Tab: the selected one.
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "0", "-1"]);

    review.focus();
    const scoped = sessionGets(log).length;
    fireEvent.keyDown(review, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Implement/ }));
    expect(sessionGets(log)).toHaveLength(scoped);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Whole run" }));
    // Wrapping, so the far end of a long strip is one press away from either end of it.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Ship/ }));
  });

  it("leaves a Task on no Workflow exactly as it was", async () => {
    const { log } = renderWithTrpc(<TaskWorkspace taskId={TASK_ID} />, {
      "task.get": () => task({ state: "running" }),
      "session.listForTask": () => [session],
      "session.get": () =>
        detail([{ kind: "assistant_turn", text: "patched latch.ts", thinking: false }]),
      "stream.ticket": () => ({
        url: "ws://hub.test/?ticket=t",
        expiresAt: "2026-01-01T00:01:00.000Z",
      }),
    });

    await screen.findByText(/patched latch.ts/);
    // No strip, so no Step tabs, so no panel pretending to be one half of a relationship with
    // them — and the transcript request is the one this page has always made. (The right column
    // has a tablist of its own; the terminal is the panel under test.)
    expect(screen.queryByRole("region", { name: "Workflow progress" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Whole run" })).toBeNull();
    expect(document.getElementById("task-terminal-panel")?.getAttribute("role")).not.toBe(
      "tabpanel",
    );
    expect(screen.queryByText(/The rest of this run/)).toBeNull();
    for (const call of sessionGets(log)) {
      expect(call.input).toEqual({ sessionId: SESSION_ID });
    }
  });
});
