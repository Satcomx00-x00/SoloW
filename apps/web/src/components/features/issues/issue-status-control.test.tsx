/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { type IssueDto, IssueErrorCode } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { IssueStatusControl } from "./issue-status-control";

/**
 * The manual status override (spec F01 FR-7) and the close guard (FR-9).
 *
 * What these hold onto: an override is *shown* as an override rather than silently replacing the
 * derived status, clearing it is reachable from the same menu that sets it, and closing an Issue
 * over active Tasks takes two asks — the second one stating how much work it would leave behind.
 */

function issueWith(overrides: Partial<IssueDto> = {}): IssueDto {
  return {
    id: "issue-1",
    title: "Fix the latch",
    description: null,
    status: "in_progress",
    derivedStatus: "in_progress",
    statusOverride: null,
    statusOverrideAt: null,
    taskCount: 2,
    activeTaskCount: 1,
    source: "local",
    repositoryId: null,
    externalNumber: null,
    externalUrl: null,
    externalId: null,
    externalParentId: null,
    syncedAt: null,
    labels: [],
    linkedChangeRequests: [],
    assignees: [],
    milestone: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Radix opens a menu on pointerdown and selects an item on Enter — neither of which
 * `fireEvent.click` produces, and happy-dom has no pointer events to fire. Enter is the keyboard
 * path a user has anyway, and it is the one this environment can drive honestly.
 */
function openStatusMenu(status: string): void {
  fireEvent.keyDown(screen.getByRole("button", { name: new RegExp(`^Status: ${status}`) }), {
    key: "Enter",
  });
}

async function choose(name: string | RegExp): Promise<void> {
  fireEvent.keyDown(await screen.findByRole("menuitem", { name }), { key: "Enter" });
}

afterEach(cleanup);

describe("IssueStatusControl", () => {
  it("sends the status the user picked", async () => {
    const { log } = renderWithTrpc(<IssueStatusControl issue={issueWith()} />, {
      "issue.setStatus": () => issueWith({ status: "resolved", statusOverride: "resolved" }),
    });

    openStatusMenu("In progress");
    await choose("Resolved");

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "issue.setStatus");
      expect(call?.input).toEqual({ id: "issue-1", status: "resolved", force: false });
    });
  });

  it("says an override is one, and what the tasks say underneath it", () => {
    renderWithTrpc(
      <IssueStatusControl
        issue={issueWith({
          status: "closed",
          statusOverride: "closed",
          statusOverrideAt: "2026-02-03T00:00:00.000Z",
          derivedStatus: "in_progress",
        })}
      />,
      {},
    );

    // The badge reads the override; the line under it keeps the derived status visible, which is
    // the whole reason both travel in the DTO.
    expect(screen.getByRole("button", { name: /^Status: Closed/ })).toBeTruthy();
    const note = screen.getByText(/Set by hand/);
    expect(note.textContent).toContain("its tasks read In progress");
  });

  it("clears the override back to the derived status", async () => {
    const { log } = renderWithTrpc(
      <IssueStatusControl issue={issueWith({ status: "closed", statusOverride: "closed" })} />,
      { "issue.setStatus": () => issueWith() },
    );

    openStatusMenu("Closed");
    await choose(/Follow tasks/);

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "issue.setStatus");
      expect(call?.input).toEqual({ id: "issue-1", status: null, force: false });
    });
  });

  it("offers nothing to clear when the status is only derived", async () => {
    renderWithTrpc(<IssueStatusControl issue={issueWith()} />, {});

    openStatusMenu("In progress");
    const clear = await screen.findByRole("menuitem", { name: /Follow tasks/ });
    expect(clear.getAttribute("aria-disabled")).toBe("true");
  });

  it("turns a refused close into a warning that states the cost, then closes when forced", async () => {
    let forced = false;
    const { log } = renderWithTrpc(
      <IssueStatusControl issue={issueWith({ activeTaskCount: 2 })} />,
      {
        "issue.setStatus": (input) => {
          const asked = input as { force: boolean };
          if (!asked.force) throw new Error(IssueErrorCode.HasActiveTasks);
          forced = true;
          return issueWith({ status: "closed", statusOverride: "closed" });
        },
      },
    );

    openStatusMenu("In progress");
    await choose("Closed");

    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("2 tasks under this issue are still active");
    // The raw error code is never what the user reads.
    expect(warning.textContent).not.toContain("ISSUE_HAS_ACTIVE_TASKS");

    fireEvent.click(screen.getByRole("button", { name: "Close anyway" }));
    await waitFor(() => expect(forced).toBe(true));
    expect(log.calls.filter((c) => c.path === "issue.setStatus").at(-1)?.input).toEqual({
      id: "issue-1",
      status: "closed",
      force: true,
    });
  });

  it("lets the user back out of a refused close without closing anything", async () => {
    const { log } = renderWithTrpc(<IssueStatusControl issue={issueWith()} />, {
      "issue.setStatus": () => {
        throw new Error(IssueErrorCode.HasActiveTasks);
      },
    });

    openStatusMenu("In progress");
    await choose("Closed");
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(log.calls.filter((c) => c.path === "issue.setStatus").length).toBe(1);
  });

  it("surfaces any other failure rather than swallowing it", async () => {
    renderWithTrpc(<IssueStatusControl issue={issueWith()} />, {
      "issue.setStatus": () => {
        throw new Error("database is locked");
      },
    });

    openStatusMenu("In progress");
    await choose("Resolved");

    expect((await screen.findByRole("alert")).textContent).toContain("database is locked");
  });
});
