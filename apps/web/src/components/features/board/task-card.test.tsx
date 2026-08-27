/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import type { IssueDto, TaskDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { type BoardReferences, BoardReferencesProvider } from "./board-references";
import { TaskCard } from "./task-card";

/**
 * What a card says about where the work is, and what can be done to the Issue behind it.
 *
 * A `TaskDto` names its Repository and its Issue by id, so the card used to show a branch and
 * nothing else — and before a run had produced a result branch, eight characters of the Task's
 * own id under a `GitBranch` glyph. An Owner scanning thirty cards could not tell which
 * repository any of them touched, nor which Issue it came from without opening it.
 */

const task: TaskDto = {
  id: "task-1",
  issueId: "issue-1",
  title: "Cap the upload size",
  state: "ready",
  agentProfileId: "agent-1",
  executorProfileId: "exec-1",
  repositories: [
    {
      id: "attach-1",
      repositoryId: "repo-1",
      baseRef: null,
      checkoutBranch: "solow/task-1",
      resultBranch: null,
      position: 0,
    },
  ],
  failureReason: null,
  completedAt: null,
  completedOutcome: null,
  completedSummary: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const issue: IssueDto = {
  id: "issue-1",
  title: "Uploads over 2 MB are rejected",
  description: null,
  status: "open",
  derivedStatus: "open",
  statusOverride: null,
  statusOverrideAt: null,
  taskCount: 1,
  activeTaskCount: 1,
  source: "github",
  repositoryId: "repo-1",
  externalNumber: 42,
  externalUrl: "https://github.com/acme/api/issues/42",
  externalId: null,
  externalParentId: null,
  syncedAt: null,
  labels: ["bug"],
  linkedChangeRequests: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const references: BoardReferences = {
  repositoryName: (id) => (id === "repo-1" ? "api" : null),
  issue: (id) => (id === "issue-1" ? issue : null),
};

function show(over: Partial<TaskDto> = {}, refs: BoardReferences = references) {
  return renderWithTrpc(
    <BoardReferencesProvider value={refs}>
      <TaskCard task={{ ...task, ...over }} />
    </BoardReferencesProvider>,
    {
      "issue.setStatus": () => ({ ...issue, status: "resolved" }),
      // How the provider spells its own name comes from the registry now (F21) — there is no
      // table of names left in the web app to read it from.
      "integration.providers": () => [
        { id: "github", name: "GitHub", capabilities: ["issues"], fields: [] },
      ],
    },
  );
}

const menuLabel = "#42: Uploads over 2 MB are rejected. Edit this issue";

/**
 * Radix opens a menu on pointerdown and selects an item on Enter — neither of which
 * `fireEvent.click` produces, and happy-dom has no pointer events to fire. Enter is the keyboard
 * path a user has anyway, and it is the one this environment can drive honestly. Same helper as
 * `issue-status-control.test.tsx`, for the same reason.
 */
function openMenu(name: string = menuLabel): void {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
}

async function choose(name: string | RegExp): Promise<void> {
  fireEvent.keyDown(await screen.findByRole("menuitem", { name }), { key: "Enter" });
}

afterEach(cleanup);

describe("TaskCard references", () => {
  it("names the repository and the branch the work is on", () => {
    show();
    expect(screen.getByText("api")).toBeDefined();
    expect(screen.getByText("solow/task-1")).toBeDefined();
  });

  it("prefers the result branch once a run has produced one", () => {
    show({
      repositories: [{ ...task.repositories[0]!, resultBranch: "solow/task-1-final" }],
    });
    expect(screen.getByText("solow/task-1-final")).toBeDefined();
  });

  it("still renders with no references above it", () => {
    // The card is used bare in the drag overlay; a missing provider must cost it a line, not a
    // render.
    renderWithTrpc(<TaskCard task={task} />);
    expect(screen.getByText("solow/task-1")).toBeDefined();
    expect(screen.queryByText("api")).toBeNull();
  });
});

describe("TaskCard issue menu", () => {
  it("labels the trigger with the number and the issue's own title", () => {
    show();
    expect(screen.getByRole("button", { name: menuLabel })).toBeDefined();
  });

  it("changes the issue's status without leaving the board", async () => {
    const { log } = show();
    openMenu();
    await choose(/Resolved/);

    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "issue.setStatus")).toBe(true);
    });
    expect(log.calls.find((c) => c.path === "issue.setStatus")?.input).toMatchObject({
      id: "issue-1",
      status: "resolved",
    });
  });

  it("offers the provider's own page, in a new tab", async () => {
    show();
    openMenu();
    const link = await screen.findByRole("menuitem", { name: /View on GitHub/ });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/api/issues/42");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("omits the provider link for an issue that was never imported", async () => {
    const local: IssueDto = {
      ...issue,
      source: "local",
      externalNumber: null,
      externalUrl: null,
      externalId: null,
      externalParentId: null,
    };
    show({}, { ...references, issue: () => local });
    openMenu(`Issue: ${local.title}. Edit this issue`);
    // The status items are still there — a local Issue is just as editable.
    expect(await screen.findByRole("menuitem", { name: /Resolved/ })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: /View on/ })).toBeNull();
  });
});

describe("TaskCard issue menu, provider not installed", () => {
  it("names the provider by its own id rather than showing nothing", async () => {
    // F21 FR-7, at the surface an Owner actually looks at. An Issue imported by a build that
    // shipped a driver this one does not have still reads: `jira`, not `undefined`, and not a
    // card that fails to render. The link still works — it is the provider's own URL, stored
    // with the Issue, and needs no driver to open.
    const foreign: IssueDto = { ...issue, source: "jira", externalNumber: 7 };
    renderWithTrpc(
      <BoardReferencesProvider value={{ ...references, issue: () => foreign }}>
        <TaskCard task={task} />
      </BoardReferencesProvider>,
      { "integration.providers": () => [] },
    );

    fireEvent.keyDown(
      screen.getByRole("button", { name: `#7: ${foreign.title}. Edit this issue` }),
      { key: "Enter" },
    );
    expect(await screen.findByRole("menuitem", { name: /View on jira/ })).toBeDefined();
  });
});

/**
 * The completion gate (the green control).
 *
 * A run finishing is not the same event as work being ready, and neither is the same as a person
 * deciding to look at it. The card is where those three come apart: it reports what the agent
 * declared, and offers exactly one action — and only when there is something to judge.
 */
describe("the completion gate", () => {
  const FINISHED: Partial<TaskDto> = {
    state: "running",
    completedAt: "2026-08-24T18:00:00.000Z",
    completedOutcome: "changes_ready",
    completedSummary: "Pinned 5 dependencies",
  };

  function showGate(over: Partial<TaskDto> = {}, onSubmitForReview?: (id: string) => void) {
    return renderWithTrpc(
      <BoardReferencesProvider value={references}>
        <TaskCard
          task={{ ...task, ...over }}
          {...(onSubmitForReview ? { onSubmitForReview } : {})}
        />
      </BoardReferencesProvider>,
      { "issue.setStatus": () => ({ ...issue, status: "resolved" }) },
    );
  }

  it("offers nothing while the agent has declared nothing", () => {
    showGate({ state: "running" }, () => {});

    expect(screen.queryByRole("button", { name: /open review/i })).toBeNull();
    expect(screen.queryByText("Finished")).toBeNull();
  });

  it("shows the control once the agent says the work is ready", () => {
    showGate(FINISHED, () => {});

    expect(screen.getByRole("button", { name: /open review/i })).toBeDefined();
  });

  it("opens the gate on the operator's click, and only then", () => {
    const onSubmitForReview = mock(() => {});
    showGate(FINISHED, onSubmitForReview);

    expect(onSubmitForReview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /open review/i }));

    expect(onSubmitForReview).toHaveBeenCalledWith(task.id);
  });

  it("reports a run that finished with nothing to do, and offers no gate", () => {
    // Finishing having changed nothing is an answer, and the card should say it rather than
    // looking like a Task that stalled. There is still nothing to approve.
    showGate({ ...FINISHED, completedOutcome: "nothing_to_do" }, () => {});

    expect(screen.getByText(/nothing to do/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /open review/i })).toBeNull();
  });

  it("reports a run that gave up, and offers no gate", () => {
    showGate({ ...FINISHED, completedOutcome: "blocked" }, () => {});

    expect(screen.getByText(/blocked/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /open review/i })).toBeNull();
  });

  it("offers no control on a board that cannot act", () => {
    showGate(FINISHED);

    expect(screen.queryByRole("button", { name: /open review/i })).toBeNull();
    // ...but still says the agent finished, because that is a fact about the Task.
    expect(screen.getByText("Finished")).toBeDefined();
  });
});
