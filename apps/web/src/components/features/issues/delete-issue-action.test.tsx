/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { IssueErrorCode } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { DeleteIssueAction } from "./delete-issue-action";

/**
 * Deleting an Issue (issue #15 reversal) reuses `ConfirmAction` and translates
 * `ISSUE_HAS_TASKS` — the server's refusal (spec F01 States & Rules) — into the same rule
 * stated back to the user, not a raw wire code.
 *
 * The force path is deliberately only reachable *after* that refusal, so these tests drive it
 * the way a user must: delete, get told no, then choose the cascade.
 */

afterEach(cleanup);

describe("DeleteIssueAction", () => {
  it("confirming delete on a clean Issue calls issue.delete and reports success upstream", async () => {
    let onSuccessCalled = false;
    const { log } = renderWithTrpc(
      <DeleteIssueAction
        issueId="issue-1"
        issueTitle="Fix the latch"
        onSuccess={() => {
          onSuccessCalled = true;
        }}
        trigger={<button type="button">Delete</button>}
      />,
      { "issue.delete": () => ({ id: "issue-1", deletedTaskCount: 0 }) },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete issue" }));

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "issue.delete")).toBe(true);
    });
    expect(log.calls.find((c) => c.path === "issue.delete")?.input).toEqual({
      id: "issue-1",
      force: false,
    });
    await waitFor(() => expect(onSuccessCalled).toBe(true));
  });

  it("surfaces ISSUE_HAS_TASKS as the F01 rule, not the raw wire code", async () => {
    renderWithTrpc(
      <DeleteIssueAction
        issueId="issue-2"
        issueTitle="Has tasks against it"
        trigger={<button type="button">Delete</button>}
      />,
      {
        "issue.delete": () => {
          throw new Error(IssueErrorCode.HasTasks);
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete issue" }));

    const message = await screen.findByRole("alert");
    expect(message.textContent).toContain("move or remove them first");
    expect(message.textContent).not.toContain(IssueErrorCode.HasTasks);
  });

  it("offers the force delete only once the plain delete has been refused", async () => {
    renderWithTrpc(
      <DeleteIssueAction
        issueId="issue-3"
        issueTitle="Has tasks against it"
        trigger={<button type="button">Delete</button>}
      />,
      {
        "issue.delete": () => {
          throw new Error(IssueErrorCode.HasTasks);
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    // Before the refusal there is no cascade on offer — that is the whole point of the two gates.
    expect(screen.queryByRole("button", { name: /anyway/ })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Delete issue" }));
    expect(await screen.findByRole("button", { name: /anyway/ })).toBeTruthy();
  });

  it("force delete sends force:true and states what it will destroy, worktrees included", async () => {
    let deleted = false;
    renderWithTrpc(
      <DeleteIssueAction
        issueId="issue-4"
        issueTitle="Abandoned"
        trigger={<button type="button">Delete</button>}
      />,
      {
        "issue.delete": (input: unknown) => {
          const { force } = input as { force: boolean };
          if (!force) throw new Error(IssueErrorCode.HasTasks);
          deleted = true;
          return { id: "issue-4", deletedTaskCount: 3 };
        },
        "issue.deletionImpact": () => ({
          taskCount: 3,
          runningTaskCount: 1,
          sessionCount: 5,
          worktreeCount: 2,
        }),
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete issue" }));
    fireEvent.click(await screen.findByRole("button", { name: /anyway/ }));

    const body = await screen.findByText(/3 tasks and 5 sessions/);
    expect(body.textContent).toContain("1 task still running will be stopped first");
    expect(body.textContent).toContain("2 git worktrees will be left on disk");

    fireEvent.click(await screen.findByRole("button", { name: "Force delete" }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it("says nothing was deleted when the running tasks could not be stopped", async () => {
    renderWithTrpc(
      <DeleteIssueAction
        issueId="issue-5"
        issueTitle="Orchestrator down"
        trigger={<button type="button">Delete</button>}
      />,
      {
        "issue.delete": (input: unknown) => {
          const { force } = input as { force: boolean };
          throw new Error(force ? IssueErrorCode.StopFailed : IssueErrorCode.HasTasks);
        },
        "issue.deletionImpact": () => ({
          taskCount: 1,
          runningTaskCount: 1,
          sessionCount: 1,
          worktreeCount: 0,
        }),
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete issue" }));
    fireEvent.click(await screen.findByRole("button", { name: /anyway/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Force delete" }));

    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert.textContent).toContain("nothing was deleted");
      expect(alert.textContent).not.toContain(IssueErrorCode.StopFailed);
    });
  });
});
