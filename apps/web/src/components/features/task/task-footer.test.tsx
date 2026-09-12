/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskDependencyDto, TaskDto } from "@solow/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskFooter } from "./task-footer";

/**
 * The foot of the Task page answers per state, and the answers below are the ones an operator
 * would otherwise have to go back to the board for. Each case asserts the *control* offered, by
 * its accessible name, and the intent it hands back — never the sentence beside it, which is
 * free to be reworded.
 */

afterEach(cleanup);

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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function renderFooter(
  over: Partial<TaskDto>,
  extra: Partial<Parameters<typeof TaskFooter>[0]> = {},
) {
  const calls: string[] = [];
  render(
    <TaskFooter
      task={task(over)}
      consequences="1 repository, 1 branch, 3 files"
      decidePending={null}
      onDecide={(d) => calls.push(`decide:${d}`)}
      onLaunch={() => calls.push("launch")}
      onRetry={() => calls.push("retry")}
      onOpenReview={() => calls.push("open-review")}
      onReopen={() => calls.push("reopen")}
      renewHref="/settings?section=secrets&renewSecret=anthropic"
      error={null}
      {...extra}
    />,
  );
  return calls;
}

describe("TaskFooter", () => {
  it("offers Launch on a Ready task, and nothing that looks like a review", () => {
    const calls = renderFooter({ state: "ready" });
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    expect(calls).toEqual(["launch"]);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("refuses Launch while a predecessor is not Done, naming it", () => {
    const outstanding: TaskDependencyDto[] = [
      {
        taskId: "task-1",
        blockedByTaskId: "task-0",
        blockedByTitle: "Pour the foundation",
        blockedByState: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const calls = renderFooter({ state: "ready" }, { outstanding });
    const launch = screen.getByRole("button", { name: "Launch" });
    expect(launch.hasAttribute("disabled")).toBe(true);
    fireEvent.click(launch);
    expect(calls).toEqual([]);
    expect(screen.getByText(/Waiting on Pour the foundation \(Running\)/)).toBeDefined();
  });

  it("offers Retry on a failed run, with the reason in words rather than as its class", () => {
    const calls = renderFooter({ state: "failed", failureReason: "interrupted" });
    expect(screen.getByText("Interrupted by restart")).toBeDefined();
    expect(screen.queryByText("interrupted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(calls).toEqual(["retry"]);
  });

  it("sends an expired credential to Renew instead of retrying into the same failure", () => {
    renderFooter({ state: "failed", failureReason: "credential_expired" });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    const renew = screen.getByRole("link", { name: "Renew" });
    expect(renew.getAttribute("href")).toContain("renewSecret=anthropic");
  });

  it("lets a parked task be resumed now rather than when the window resets", () => {
    const calls = renderFooter({ state: "parked", failureReason: "park" });
    expect(screen.getByText("Paused on quota")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(calls).toEqual(["retry"]);
  });

  it("offers no second 'Move to Ready' on a backlog task — the header arrow is the one", () => {
    renderFooter({ state: "backlog" });
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/in the backlog/)).toBeDefined();
  });

  it("keeps the review gate exactly as it was: three decisions, one scope line", () => {
    const calls = renderFooter({ state: "review" });
    expect(screen.getByText(/Approving covers 1 repository, 1 branch, 3 files/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    expect(calls).toEqual(["decide:approve", "decide:request_changes"]);
    // Reject is destructive and confirms first, so a single click hands nothing back.
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(calls).toHaveLength(2);
  });

  it("says how much of the change was read, on the gate and never as a lock", () => {
    renderFooter({ state: "review" }, { viewed: { viewed: 7, of: 12 } });
    expect(screen.getByText(/7 of 12 files viewed/)).toBeDefined();
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve.hasAttribute("disabled")).toBe(false);
  });

  it("reopens a Done task — back to Ready, never straight into a run", () => {
    const calls = renderFooter({ state: "done", completedSummary: "Shipped the latch." });
    expect(screen.getByText("Shipped the latch.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(calls).toEqual(["reopen"]);
  });

  it("lists what the harness left open above the decision, and names it on the button", () => {
    renderFooter(
      { state: "review" },
      {
        openItems: [
          { label: "Migration applied", why: "no Postgres reachable from this sandbox" },
          { label: "Record the decision on issue #115", why: null },
        ],
      },
    );
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("2 open items");
    expect(banner.textContent).toContain("no Postgres reachable");
    const approve = screen.getByRole("button", { name: /Approve with 2 open items/ });
    // Impossible to miss; never a lock.
    expect(approve.hasAttribute("disabled")).toBe(false);
  });

  it("re-runs a review gate whose decision was never applied, instead of offering a dead gate", () => {
    const calls = renderFooter({ state: "review", failureReason: "review_decision_not_applied" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText("Decision not applied")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(calls).toEqual(["retry"]);
  });

  it("locks every decision while one is in flight", () => {
    renderFooter({ state: "review" }, { decidePending: "approve" });
    for (const name of ["Approve", "Request changes", "Reject"]) {
      expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true);
    }
  });

  it("opens the gate on a finished run from the foot, where the decisions are", () => {
    const calls = renderFooter({
      state: "running",
      completedOutcome: "changes_ready",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open review" }));
    expect(calls).toEqual(["open-review"]);
  });

  it("offers the gate on a plan-only Workflow Step, and says the plan is what is reviewed", () => {
    const calls = renderFooter({
      state: "running",
      completedOutcome: "nothing_to_do",
      completedAt: "2026-01-01T00:00:00.000Z",
      workflowId: "wf-1",
      workflowStepId: "st-1",
    });
    expect(screen.getByText(/plan is ready/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open review" }));
    expect(calls).toEqual(["open-review"]);
  });

  it("offers nothing to open while the harness is still working", () => {
    renderFooter({ state: "running" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a refusal in words under whichever control produced it", () => {
    renderFooter(
      { state: "failed", failureReason: "fail" },
      { error: "Another run is using the last free slot." },
    );
    expect(screen.getByRole("alert").textContent).toContain("last free slot");
  });
});
