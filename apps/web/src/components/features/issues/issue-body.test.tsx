/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { IssueDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { IssueBody } from "./issue-body";

/**
 * An Issue's description, read and written on the Issue's own page.
 *
 * Two claims, and the second is the one with teeth. The body is **markdown** — it used to be one
 * flat `whitespace-pre-wrap` paragraph, so a checklist arrived as literal `- [ ]` and a fenced
 * repro as backticks. And an edit goes to **whoever owns the text**: `issue.update` for a local
 * Issue, `issue.updateExternal` for an imported one, because the DAL refuses a description on an
 * imported Issue by name (`ISSUE_SOURCE_OWNED`, F01 FR-3) and an editor that ignored that would
 * be a Save button that always fails.
 */
afterEach(cleanup);

const TIMESTAMPS = { createdAt: "2026-08-26T00:00:00.000Z", updatedAt: "2026-08-26T00:00:00.000Z" };

function makeIssue(patch: Partial<IssueDto> = {}): IssueDto {
  return {
    id: "issue-1",
    title: "Fix the latch",
    description: "## Steps\n\n- [ ] reproduce\n- [ ] fix",
    status: "open",
    derivedStatus: "open",
    statusOverride: null,
    statusOverrideAt: null,
    taskCount: 0,
    activeTaskCount: 0,
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
    ...TIMESTAMPS,
    ...patch,
  };
}

/** What `issue.detail` answers for an imported Issue whose provider accepts a description. */
const DETAIL = {
  issueId: "issue-1",
  externalNumber: 42,
  externalUrl: "https://example.test/42",
  title: "Fix the latch",
  description: "the provider's current body",
  state: "open" as const,
  assignees: [],
  labels: [],
  milestone: null,
  availableLabels: [],
  availableAssignees: [],
  availableMilestones: [],
  subIssues: [],
  writes: ["description" as const],
  cannot: {},
};

describe("the issue body", () => {
  it("renders the description as markdown, not as its source", async () => {
    renderWithTrpc(<IssueBody issue={makeIssue()} />);

    // The heading is a heading and the checklist is a list — the two things a flat paragraph
    // could never show.
    expect(await screen.findByRole("heading", { name: "Steps" })).toBeDefined();
    expect(screen.getByRole("list")).toBeDefined();
    expect(screen.queryByText(/^## Steps/)).toBeNull();
  });

  it("offers to add one when the issue has no description", () => {
    renderWithTrpc(<IssueBody issue={makeIssue({ description: null })} />);

    expect(screen.getByRole("button", { name: "Add one" })).toBeDefined();
  });

  it("writes a local issue through issue.update", async () => {
    const { log } = renderWithTrpc(<IssueBody issue={makeIssue()} />, {
      "issue.update": () => makeIssue({ description: "rewritten" }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "rewritten" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(log.calls.some((c) => c.path === "issue.update")).toBe(true));
    expect(log.calls.find((c) => c.path === "issue.update")?.input).toEqual({
      id: "issue-1",
      description: "rewritten",
    });
    // The local path must never reach the provider route: it would be refused, and the refusal
    // would arrive as a raw error code under a Save button that looked fine.
    expect(log.calls.some((c) => c.path === "issue.updateExternal")).toBe(false);
  });

  it("sends an imported issue's body to its provider, seeded from what the provider holds now", async () => {
    const { log } = renderWithTrpc(<IssueBody issue={makeIssue({ source: "github" })} />, {
      "issue.detail": () => DETAIL,
      "issue.updateExternal": () => DETAIL,
    });

    // Nothing is asked of the provider until the editor opens — the read is four network calls.
    expect(log.calls.some((c) => c.path === "issue.detail")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    // The editor opens on the provider's body, not on the mirror's copy of it. A form seeded from
    // the last poll saves over whatever somebody changed since.
    const box = await screen.findByLabelText("Description");
    await waitFor(() =>
      expect((box as HTMLTextAreaElement).value).toBe("the provider's current body"),
    );

    fireEvent.change(box, { target: { value: "edited upstream" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(log.calls.some((c) => c.path === "issue.updateExternal")).toBe(true),
    );
    expect(log.calls.find((c) => c.path === "issue.updateExternal")?.input).toEqual({
      issueId: "issue-1",
      description: "edited upstream",
    });
    expect(log.calls.some((c) => c.path === "issue.update")).toBe(false);
  });

  it("says why instead of offering an editor a provider would refuse", async () => {
    // Decision 0016: ask for a capability, never for a provider. A tracker that will not accept a
    // description change says so where the box would have been, rather than at the end of a save.
    renderWithTrpc(<IssueBody issue={makeIssue({ source: "gitea" })} />, {
      "issue.detail": () => ({
        ...DETAIL,
        writes: [],
        cannot: { description: "This provider does not support editing issues from SoloW." },
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(await screen.findByText(/does not support editing issues/)).toBeDefined();
    expect(screen.queryByLabelText("Description")).toBeNull();
  });
});
