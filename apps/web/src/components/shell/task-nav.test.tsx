/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TaskDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { TaskNav } from "./task-nav";

/**
 * The Task page's sidebar gathers the page's own controls into one column. These assert that
 * each control appears only in the state it applies to, issues the page's mutation, and that
 * the Step list reads the same colours the header strip does.
 */

const AT = "2026-08-20T00:00:00.000Z";

function task(over: Partial<TaskDto> = {}): TaskDto {
  return {
    id: "task-1",
    issueId: "issue-1",
    title: "Fix the gate latch",
    state: "ready",
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
    workflowId: null,
    workflowStepId: null,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  } as TaskDto;
}

const session = {
  id: "sess-1",
  taskId: "task-1",
  state: "awaiting_review" as const,
  diffRef: "solow/task-1",
  startedAt: AT,
  endedAt: null,
};

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
  createdAt: AT,
  updatedAt: AT,
});
const steps = [step("st-1", "Implement", 0), step("st-2", "Review", 1)];

function handlers(t: TaskDto, extra: Record<string, (input: unknown) => unknown> = {}) {
  return {
    "task.get": () => t,
    "session.listForTask": () => [session],
    "project.forIssue": () => ({ projectId: "proj-1" }),
    "workflow.list": () => [],
    "workflow.taskBinding": () => ({
      taskId: t.id,
      workflowId: "wf-1",
      workflowName: "Implement & review",
      attachedVersion: 1,
      currentVersion: 1,
      definitionDrifted: false,
      currentStep: steps.find((s) => s.id === t.workflowStepId) ?? steps[0],
      steps,
      handoff: null,
      brief: "Do it.",
    }),
    "task.launch": () => ({ ok: true }),
    "task.move": () => ({ ok: true }),
    "review.decide": () => ({ ok: true }),
    ...extra,
  };
}

describe("TaskNav", () => {
  beforeEach(() => {
    installFakeWebSocket();
  });
  afterEach(cleanup);

  it("launches a Ready Task from the sidebar, and goes where the page's back link goes", async () => {
    const { log } = renderWithTrpc(<TaskNav taskId="task-1" />, handlers(task()));

    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "task.launch")?.input).toEqual({ id: "task-1" });
    });
    const goTo = screen.getByRole("navigation", { name: "Go to" });
    expect(within(goTo).getByRole("link", { name: "Board" }).getAttribute("href")).toBe(
      "/projects/proj-1/board",
    );
    expect(within(goTo).getByRole("link", { name: "Issue" }).getAttribute("href")).toBe(
      "/issues/issue-1",
    );
    expect(within(goTo).queryByRole("link", { name: "Workflow" })).toBeNull();
  });

  it("offers the review verdicts only in Review, and records one against the latest session", async () => {
    const { log } = renderWithTrpc(
      <TaskNav taskId="task-1" />,
      handlers(task({ state: "review" })),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(log.calls.find((c) => c.path === "review.decide")?.input).toEqual({
        sessionId: "sess-1",
        decision: "approve",
      });
    });
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
    // Rejecting is destructive, so it is confirmed rather than done on one click.
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByRole("alertdialog")).toBeDefined();
  });

  it("lists the Workflow's Steps in the colours the header strip uses, with the current one marked", async () => {
    renderWithTrpc(
      <TaskNav taskId="task-1" />,
      handlers(task({ state: "running", workflowId: "wf-1", workflowStepId: "st-2" })),
    );

    const list = await screen.findByRole("navigation", { name: "Workflow steps" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("data-status"))).toEqual(["done", "running"]);
    expect(items[1]?.getAttribute("aria-current")).toBe("step");
    expect(
      within(screen.getByRole("navigation", { name: "Go to" }))
        .getByRole("link", { name: "Workflow" })
        .getAttribute("href"),
    ).toBe("/workflows/wf-1");
  });

  it("colours a Step waiting on a person orange and a failed one red", async () => {
    renderWithTrpc(
      <TaskNav taskId="task-1" />,
      handlers(task({ state: "review", workflowId: "wf-1", workflowStepId: "st-1" })),
    );
    const list = await screen.findByRole("navigation", { name: "Workflow steps" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("data-status")),
    ).toEqual(["waiting", "upcoming"]);
    cleanup();

    renderWithTrpc(
      <TaskNav taskId="task-1" />,
      handlers(task({ state: "failed", workflowId: "wf-1", workflowStepId: "st-2" })),
    );
    const again = await screen.findByRole("navigation", { name: "Workflow steps" });
    expect(
      within(again)
        .getAllByRole("listitem")
        .map((li) => li.getAttribute("data-status")),
    ).toEqual(["done", "failed"]);
  });
});
