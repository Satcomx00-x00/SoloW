/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TaskDto, TaskState } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { WorkspaceEventsProvider } from "@/lib/workspace-events";
import { installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { Board } from "../board/board";

/**
 * A launch asks which Workflow first (spec F03): the answer is written as the Task's binding,
 * and only then does the launch the caller already had run. With nothing to choose from, the
 * button does what it always did — the older board tests, which list no Workflow, cover that.
 */

const AT = "2026-08-20T00:00:00.000Z";

function makeTask(over: Partial<TaskDto> & { id: string; state: TaskState }): TaskDto {
  return {
    workspaceId: "ws-1",
    issueId: "issue-1",
    title: "Fix the gate latch",
    agentProfileId: "ap-1",
    executorProfileId: "ep-1",
    repositories: [],
    failureReason: null,
    workflowId: null,
    workflowStepId: null,
    completedAt: null,
    completedOutcome: null,
    completedSummary: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  } as TaskDto;
}

const workflows = [
  {
    id: "wf-1",
    name: "Implement & review",
    description: "Implement, then a reviewer decides.",
    version: 1,
    stepCount: 2,
    createdAt: AT,
    updatedAt: AT,
  },
  {
    id: "wf-2",
    name: "Bug fix",
    description: null,
    version: 1,
    stepCount: 3,
    createdAt: AT,
    updatedAt: AT,
  },
];

function handlers(task: TaskDto, extra: Record<string, (input: unknown) => unknown> = {}) {
  return {
    "stream.ticket": () => ({ ticket: "t", url: "ws://localhost/ws" }),
    "task.list": () => ({ items: [task], nextCursor: null }),
    "task.dependencies": () => [],
    "workflow.list": () => workflows,
    "workflow.attachTask": () => ({ ok: true }),
    "workflow.detachTask": () => ({ ok: true }),
    "task.launch": () => ({ ok: true }),
    ...extra,
  };
}

function Live({ children }: { children: React.ReactNode }) {
  return <WorkspaceEventsProvider>{children}</WorkspaceEventsProvider>;
}

describe("LaunchTaskDialog", () => {
  beforeEach(() => {
    installFakeWebSocket();
  });
  afterEach(cleanup);

  it("asks which Workflow, binds the Task to the chosen one, then launches", async () => {
    const task = makeTask({ id: "task-1", state: "ready", title: "Launchable" });
    const { log } = renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      handlers(task),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));

    const dialog = await screen.findByRole("dialog", { name: /Launch Launchable/ });
    expect(dialog).toBeTruthy();
    // Nothing launched yet: the question comes first.
    expect(log.calls.filter((c) => c.path === "task.launch")).toHaveLength(0);
    expect((screen.getByRole("radio", { name: /No workflow/ }) as HTMLInputElement).checked).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("radio", { name: /Implement & review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Launch", hidden: false }));

    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "workflow.attachTask")?.input).toEqual({
        taskId: "task-1",
        workflowId: "wf-1",
      });
      expect(log.calls.find((c) => c.path === "task.launch")?.input).toEqual({ id: "task-1" });
    });
    // The binding is written before the launch, never after.
    const order = log.calls
      .map((c) => c.path)
      .filter((p) => p === "workflow.attachTask" || p === "task.launch");
    expect(order).toEqual(["workflow.attachTask", "task.launch"]);
  });

  it("starts from the Task's current binding, and detaches it when 'No workflow' is chosen", async () => {
    const task = makeTask({ id: "task-2", state: "ready", title: "Bound", workflowId: "wf-2" });
    const { log } = renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      handlers(task),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
    await screen.findByRole("dialog");
    expect((screen.getByRole("radio", { name: /Bug fix/ }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /No workflow/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Launch" }).at(-1)!);

    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "workflow.detachTask")?.input).toEqual({
        taskId: "task-2",
      });
      expect(log.calls.find((c) => c.path === "task.launch")?.input).toEqual({ id: "task-2" });
    });
    expect(log.calls.some((c) => c.path === "workflow.attachTask")).toBe(false);
  });

  it("launches straight away when the Workspace has no Workflow to choose from", async () => {
    const task = makeTask({ id: "task-3", state: "ready", title: "Plain" });
    const { log } = renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      handlers(task, { "workflow.list": () => [] }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "task.launch")?.input).toEqual({ id: "task-3" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a refused binding in the dialog, and does not launch", async () => {
    const task = makeTask({ id: "task-4", state: "ready", title: "Refused" });
    const { log } = renderWithTrpc(
      <Live>
        <Board />
      </Live>,
      handlers(task, {
        "workflow.attachTask": () => {
          throw new Error("WORKFLOW_TASK_NOT_ATTACHABLE");
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("radio", { name: /Implement & review/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Launch" }).at(-1)!);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "WORKFLOW_TASK_NOT_ATTACHABLE",
    );
    expect(log.calls.filter((c) => c.path === "task.launch")).toHaveLength(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
