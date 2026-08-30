/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { IssuePanel } from "./issue-panel";

/**
 * The edit drawer's half of the GitLab field work (user request 2026-08-30).
 *
 * The rule under test is the one the whole `writes`/`cannot` machinery exists for: a field the
 * provider holds gets a control, and a field it does not gets the provider's own sentence — never
 * a silently missing row. The four fields are exercised here rather than in the DAL because the
 * decision they turn on is a rendering decision.
 */

afterEach(cleanup);

const ALL_FIELDS = [
  "title",
  "description",
  "state",
  "assignees",
  "labels",
  "milestone",
  "dueDate",
  "weight",
  "confidential",
  "timeEstimate",
];

const detail = (over: Record<string, unknown> = {}) => ({
  issueId: "iss-1",
  externalNumber: 12,
  externalUrl: "https://gitlab.example/acme/web/-/issues/12",
  title: "Gate motor stalls",
  description: "It stalls in the cold.",
  state: "open",
  assignees: [],
  labels: [],
  milestone: null,
  dueDate: null,
  weight: null,
  confidential: false,
  timeEstimate: null,
  availableLabels: [],
  availableAssignees: [],
  availableMilestones: [],
  subIssues: [],
  writes: ALL_FIELDS,
  cannot: {},
  ...over,
});

const reads = {
  "issue.comments": () => ({ comments: [], canComment: false }),
};

describe("IssuePanel — the GitLab-only fields", () => {
  it("renders a control for each field the provider declares writable", async () => {
    renderWithTrpc(<IssuePanel issueId="iss-1" onOpenChange={() => {}} />, {
      "issue.detail": () => detail(),
      ...reads,
    });

    expect(await screen.findByLabelText("Due date")).toBeDefined();
    expect(screen.getByLabelText("Estimate")).toBeDefined();
    expect(screen.getByLabelText("Weight")).toBeDefined();
    expect(screen.getByText("Confidential")).toBeDefined();
  });

  it("shows the provider's own sentence instead, for a provider that holds none of them", async () => {
    renderWithTrpc(<IssuePanel issueId="iss-1" onOpenChange={() => {}} />, {
      "issue.detail": () =>
        detail({
          writes: ["title", "description", "state", "assignees", "labels", "milestone"],
          cannot: {
            dueDate: "GitHub issues have no due date.",
            weight: "GitHub issues have no weight — it is a GitLab field.",
            confidential: "GitHub issues have no confidential flag.",
            timeEstimate: "GitHub issues carry no time estimate.",
          },
        }),
      ...reads,
    });

    // The row is still there — stated, not hidden (F23 FR-5) — but as a reason, not an input.
    expect(await screen.findByText("GitHub issues have no due date.")).toBeDefined();
    expect(screen.getByText("GitHub issues have no weight — it is a GitLab field.")).toBeDefined();
    expect(screen.queryByLabelText("Due date")).toBeNull();
    expect(screen.queryByLabelText("Weight")).toBeNull();
  });

  it("commits a changed due date on blur, and sends nothing when it did not change", async () => {
    const sent: unknown[] = [];
    renderWithTrpc(<IssuePanel issueId="iss-1" onOpenChange={() => {}} />, {
      "issue.detail": () => detail({ dueDate: "2026-09-30" }),
      "issue.updateExternal": (input) => {
        sent.push(input);
        return detail({ dueDate: "2026-10-15" });
      },
      ...reads,
    });

    const due = (await screen.findByLabelText("Due date")) as HTMLInputElement;
    // Opening the drawer and blurring an untouched field must not write.
    fireEvent.blur(due);
    expect(sent).toHaveLength(0);

    fireEvent.change(due, { target: { value: "2026-10-15" } });
    fireEvent.blur(due);
    await waitFor(() => expect(sent).toEqual([{ issueId: "iss-1", dueDate: "2026-10-15" }]));
  });

  it("clears a field by emptying its box — null, not an empty string", async () => {
    const sent: unknown[] = [];
    renderWithTrpc(<IssuePanel issueId="iss-1" onOpenChange={() => {}} />, {
      "issue.detail": () => detail({ weight: 3 }),
      "issue.updateExternal": (input) => {
        sent.push(input);
        return detail();
      },
      ...reads,
    });

    const weight = await screen.findByLabelText("Weight");
    fireEvent.change(weight, { target: { value: "" } });
    fireEvent.blur(weight);

    // `null` is what clears it on the provider; "" would be a value it rejects.
    await waitFor(() => expect(sent).toEqual([{ issueId: "iss-1", weight: null }]));
  });
});
