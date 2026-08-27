/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { TaskErrorCode } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { DeleteTaskAction } from "./delete-task-action";

/**
 * The board card and the Task page mount the same component, so these cover both surfaces at
 * once. What matters is that the dialog states the real consequences before the click, and that
 * a server refusal comes back as a sentence rather than a wire code.
 */

afterEach(cleanup);

const IMPACT = {
  sessionCount: 2,
  worktreeCount: 1,
  dependentCount: 3,
  running: true,
};

function trigger(open: () => void) {
  return (
    <button onClick={open} type="button">
      Delete
    </button>
  );
}

describe("DeleteTaskAction", () => {
  it("states sessions, the running agent, unblocked tasks and the worktree left on disk", async () => {
    renderWithTrpc(
      <DeleteTaskAction taskId="task-1" taskTitle="Fix the latch" trigger={trigger} />,
      { "task.deletionImpact": () => IMPACT },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const body = await screen.findByText(/2 sessions/);
    expect(body.textContent).toContain("The running agent will be stopped first");
    expect(body.textContent).toContain("3 tasks waiting on this one will be unblocked");
    expect(body.textContent).toContain("1 git worktree will be left on disk");
  });

  it("does not ask for the impact until the dialog is opened", async () => {
    let asked = 0;
    renderWithTrpc(<DeleteTaskAction taskId="task-2" taskTitle="Quiet" trigger={trigger} />, {
      "task.deletionImpact": () => {
        asked += 1;
        return IMPACT;
      },
    });

    // One of these per card on the board — asking eagerly would be a request per card.
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy());
    expect(asked).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(asked).toBe(1));
  });

  it("confirming sends force and reports success upstream", async () => {
    let sent: unknown = null;
    let deleted = false;
    renderWithTrpc(
      <DeleteTaskAction
        onDeleted={() => {
          deleted = true;
        }}
        taskId="task-3"
        taskTitle="Abandoned"
        trigger={trigger}
      />,
      {
        "task.deletionImpact": () => ({ ...IMPACT, running: false, dependentCount: 0 }),
        "task.delete": (input: unknown) => {
          sent = input;
          return { id: "task-3" };
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete task" }));

    await waitFor(() => expect(deleted).toBe(true));
    expect(sent).toEqual({ id: "task-3", force: true });
  });

  it("says nothing was deleted when the agent could not be stopped", async () => {
    renderWithTrpc(
      <DeleteTaskAction taskId="task-4" taskTitle="Orchestrator down" trigger={trigger} />,
      {
        "task.deletionImpact": () => IMPACT,
        "task.delete": () => {
          throw new Error(TaskErrorCode.StopFailed);
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete task" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("nothing was deleted");
    expect(alert.textContent).not.toContain(TaskErrorCode.StopFailed);
  });
});
