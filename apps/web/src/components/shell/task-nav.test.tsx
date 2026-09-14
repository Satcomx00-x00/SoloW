/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TaskDto } from "@solow/contracts";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { installFakeWebSocket, renderWithTrpc } from "@/test/trpc-harness";
import { TaskNav } from "./task-nav";

/**
 * The Task page's sidebar is navigation: where to go from this Task. It no longer carries a
 * copy of the page's controls — the decision bar under every tab is the one place a verdict is
 * given — so these assert the links, and that nothing that looks like the gate is offered here.
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
    deletedAt: null,
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

  it("goes where the page's back link goes, and offers no copy of the page's controls", async () => {
    renderWithTrpc(<TaskNav taskId="task-1" />, handlers(task()));

    const goTo = await screen.findByRole("navigation", { name: "Go to" });
    // One copy of each verb, on the page: the sidebar is not a second Launch.
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Task actions" })).toBeNull();
    expect(within(goTo).getByRole("link", { name: "Board" }).getAttribute("href")).toBe(
      "/projects/proj-1/board",
    );
    expect(within(goTo).getByRole("link", { name: "Issue" }).getAttribute("href")).toBe(
      "/issues/issue-1",
    );
    expect(within(goTo).queryByRole("link", { name: "Workflow" })).toBeNull();
  });

  it("offers no verdict in Review — the gate lives in the page's decision bar, once", async () => {
    renderWithTrpc(<TaskNav taskId="task-1" />, handlers(task({ state: "review" })));

    await screen.findByRole("navigation", { name: "Go to" });
    for (const name of ["Approve", "Request changes", "Reject", "Move to Done"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("links to the Workflow a bound Task runs on, without repeating the header's Step strip", async () => {
    renderWithTrpc(
      <TaskNav taskId="task-1" />,
      handlers(task({ state: "running", workflowId: "wf-1", workflowStepId: "st-2" })),
    );

    const goTo = await screen.findByRole("navigation", { name: "Go to" });
    await waitFor(() => {
      expect(within(goTo).getByRole("link", { name: "Workflow" }).getAttribute("href")).toBe(
        "/workflows/wf-1",
      );
    });
    expect(screen.queryByRole("navigation", { name: "Workflow steps" })).toBeNull();
  });
});
