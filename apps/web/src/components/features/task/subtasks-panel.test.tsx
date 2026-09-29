/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { PARENT_CHAIN_DEPTH, ParentChain, SplitTaskButton, SubtaskList } from "./subtasks-panel";

/**
 * The split affordance (issue #56).
 *
 * Two properties are asserted rather than described, and both are about what the operator is
 * asked for: the split sends a *title* and nothing else — every other field is the parent's, and
 * a form that re-asked for them is how the feature goes unused — and the fork is on by default,
 * because carrying the parent's context is the whole reason to split rather than create.
 */

afterEach(cleanup);

function task(over: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "task-1",
    issueId: "issue-1",
    parentTaskId: null,
    forkedFrom: null,
    title: "Rewire the latch",
    state: "running",
    agentProfileId: "harness-1",
    executorProfileId: "exec-1",
    repositories: [
      {
        id: "attach-1",
        repositoryId: "repo-1",
        baseRef: null,
        checkoutBranch: "solow/task-task-1",
        resultBranch: null,
        position: 0,
      },
    ],
    failureReason: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    workflowId: null,
    workflowStepId: null,
    deletedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const page = (items: TaskDto[]) => ({ items, nextCursor: null });

/** Open the dialog, type a title, and submit — the whole of an ordinary split. */
async function split(title: string, opts: { cold?: boolean } = {}) {
  fireEvent.click(await screen.findByRole("button", { name: "Split into sub-task" }));
  fireEvent.change(screen.getByPlaceholderText("What this piece is for"), {
    target: { value: title },
  });
  if (opts.cold) fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Create sub-task" }));
}

describe("SubtaskList", () => {
  it("lists the children with the state each is in", async () => {
    const rendered = renderWithTrpc(<SubtaskList task={task()} />, {
      "task.list": () =>
        page([
          task({ id: "child-1", title: "Order the servo", state: "backlog" }),
          task({ id: "child-2", title: "Wire the relay", state: "review" }),
        ]),
    });

    expect(await screen.findByText("Order the servo")).toBeTruthy();
    expect(screen.getByText("Wire the relay")).toBeTruthy();
    // The link goes to the child's own page: a sub-task is a Task, not a checklist item.
    expect(screen.getByText("Order the servo").closest("a")?.getAttribute("href")).toBe(
      "/task/child-1",
    );
    // Asked for this Task's children, not the Workspace's Tasks.
    const call = rendered.log.calls.find((c) => c.path === "task.list");
    expect((call?.input as { parentTaskId?: string } | undefined)?.parentTaskId).toBe("task-1");
  });

  it("says what a split would do when there is nothing split off yet", async () => {
    renderWithTrpc(<SubtaskList task={task()} />, { "task.list": () => page([]) });
    expect(await screen.findByText(/Nothing split off this task/)).toBeTruthy();
  });
});

describe("SplitTaskButton", () => {
  it("asks only for a title, and forks by default", async () => {
    const rendered = renderWithTrpc(<SplitTaskButton hasTranscript task={task()} />, {
      "task.createSubtask": () => task({ id: "child-1", parentTaskId: "task-1" }),
    });

    await split("Order the servo");

    await waitFor(() => {
      const call = rendered.log.calls.find((c) => c.path === "task.createSubtask");
      // Nothing about harnesses, executors or repositories: those are the parent's, and the
      // server inherits them. `fork: true` is what makes this a split rather than a new Task.
      expect(call?.input).toEqual({
        parentTaskId: "task-1",
        title: "Order the servo",
        fork: true,
      });
    });
  });

  it("lets the split start cold when the operator says so", async () => {
    const rendered = renderWithTrpc(<SplitTaskButton hasTranscript task={task()} />, {
      "task.createSubtask": () => task({ id: "child-1", parentTaskId: "task-1" }),
    });

    await split("Something separate", { cold: true });

    await waitFor(() => {
      const call = rendered.log.calls.find((c) => c.path === "task.createSubtask");
      expect((call?.input as { fork?: boolean } | undefined)?.fork).toBe(false);
    });
  });

  it("promises no transcript for a parent that has never run", async () => {
    const rendered = renderWithTrpc(<SplitTaskButton hasTranscript={false} task={task()} />, {
      "task.createSubtask": () => task({ id: "child-1", parentTaskId: "task-1" }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Split into sub-task" }));
    expect(screen.getByText(/has not run yet, so there is no transcript to carry/)).toBeTruthy();
    expect(screen.getByRole("checkbox").hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("What this piece is for"), {
      target: { value: "Early split" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create sub-task" }));

    await waitFor(() => {
      const call = rendered.log.calls.find((c) => c.path === "task.createSubtask");
      expect((call?.input as { fork?: boolean } | undefined)?.fork).toBe(false);
    });
  });

  it("shows the new sub-task even when the list's first read was still in flight", async () => {
    // The rail renders both. The list's first read is slow and started before the create, so it
    // answers from before the sub-task existed; every read after it knows about the child.
    const child = task({ id: "child-1", parentTaskId: "task-1", title: "Split early" });
    let reads = 0;
    renderWithTrpc(
      <>
        <SubtaskList task={task()} />
        <SplitTaskButton hasTranscript task={task()} />
      </>,
      {
        "task.list": () =>
          reads++ === 0
            ? new Promise((resolve) => setTimeout(() => resolve(page([])), 300))
            : page([child]),
        "task.createSubtask": () => child,
      },
    );

    await split("Split early");

    const link = await screen.findByRole("link", { name: /Split early/ });
    expect(link.getAttribute("href")).toBe("/task/child-1");
    // And the stale first answer, landing afterwards, does not take it away again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("link", { name: /Split early/ })).toBeTruthy();
  });

  it("refuses an empty title before asking the server", async () => {
    const rendered = renderWithTrpc(<SplitTaskButton hasTranscript task={task()} />, {});

    await split("   ");

    expect(await screen.findByText("Say what the sub-task is for")).toBeTruthy();
    expect(rendered.log.calls.some((c) => c.path === "task.createSubtask")).toBe(false);
  });

  it("shows the server's refusal rather than closing on it", async () => {
    renderWithTrpc(<SplitTaskButton hasTranscript task={task()} />, {
      "task.createSubtask": () => {
        throw new Error("NOT_FOUND");
      },
    });

    await split("Order the servo");

    expect(await screen.findByRole("alert")).toBeTruthy();
    // The form is still there with what was typed in it — a refusal must not cost the operator
    // the thing they wrote.
    expect((screen.getByPlaceholderText("What this piece is for") as HTMLInputElement).value).toBe(
      "Order the servo",
    );
  });
});

describe("ParentChain", () => {
  it("walks up the chain, oldest first, each crumb a link", async () => {
    renderWithTrpc(<ParentChain parentTaskId="parent-1" />, {
      "task.get": (input) =>
        (input as { id: string }).id === "parent-1"
          ? task({ id: "parent-1", title: "Rewire the latch", parentTaskId: "root-1" })
          : task({ id: "root-1", title: "Fix the gate" }),
    });

    const parent = await screen.findByRole("link", { name: "Rewire the latch" });
    const root = await screen.findByRole("link", { name: "Fix the gate" });
    expect(parent.getAttribute("href")).toBe("/task/parent-1");
    expect(root.getAttribute("href")).toBe("/task/root-1");
    // Read left to right as the path down to this Task.
    expect(root.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stops naming ancestors past a few levels", async () => {
    // Every Task in this chain has a parent, so only the depth bound ends the walk.
    renderWithTrpc(<ParentChain parentTaskId="t-1" />, {
      "task.get": (input) => {
        const id = (input as { id: string }).id;
        const n = Number(id.slice(2));
        return task({ id, title: `Level ${n}`, parentTaskId: `t-${n + 1}` });
      },
    });

    expect(await screen.findByRole("link", { name: `Level ${PARENT_CHAIN_DEPTH}` })).toBeTruthy();
    expect(await screen.findByText("…")).toBeTruthy();
    expect(screen.queryByRole("link", { name: `Level ${PARENT_CHAIN_DEPTH + 1}` })).toBeNull();
  });

  it("renders nothing until the parent's title is known", () => {
    // A placeholder here would be a second thing moving in a header that already resizes as a
    // run's state changes.
    const { container } = renderWithTrpc(<ParentChain parentTaskId="parent-1" />, {
      "task.get": () => new Promise(() => {}),
    });
    expect(container.textContent).toBe("");
  });
});
