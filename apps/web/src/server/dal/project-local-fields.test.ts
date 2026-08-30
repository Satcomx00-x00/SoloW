import { describe, expect, it } from "bun:test";
import { deriveLocalProjectFields, type LocalFieldIssue } from "./project-local-fields.js";

/**
 * A local Project's synthesized columns (spec F23, user request 2026-08-28) — the read that
 * replaces the empty `project_field` table FR-21 guarantees a local Project always has.
 */

function issueWith(over: Partial<LocalFieldIssue> = {}): LocalFieldIssue {
  return {
    id: "issue-1",
    title: "Fixture issue",
    externalId: null,
    externalParentId: null,
    labels: [],
    assignees: [],
    milestone: null,
    linkedChangeRequests: [],
    repositoryName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    externalState: null,
    ...over,
  };
}

/**
 * GitHub Projects v2's own column set, in its own order, as a real mirrored Project reports it.
 * A local Project must declare exactly this — a GitLab-backed board that showed fewer columns is
 * the defect this list exists to catch (user request 2026-08-28).
 *
 * `Title` is the one deliberate omission: the table renders its own Title column, so deriving a
 * second one put the same string on screen twice (user request 2026-08-30).
 */
const GITHUB_COLUMNS = [
  "Assignees",
  "Status",
  "Labels",
  "Linked pull requests",
  "Milestone",
  "Repository",
  "Reviewers",
  "Parent issue",
  "Sub-issues progress",
  "Created",
  "Updated",
  "Closed",
  "Priority",
  "Size",
  "Estimate",
  "Iteration",
  "Start date",
  "Target date",
];

describe("deriveLocalProjectFields", () => {
  it("declares GitHub's exact column set, in order, even with no Issues at all", () => {
    const { fields } = deriveLocalProjectFields([]);

    expect(fields.map((f) => f.name)).toEqual(GITHUB_COLUMNS);
    expect(fields.every((f) => f.readOnly)).toBe(true);
    expect(fields.find((f) => f.name === "Status")?.options).toEqual([]);
  });

  it("keeps every column when the Issues fill almost none of them", () => {
    // The whole point of the parity: a column with nothing behind it still exists, so the two
    // tables stay comparable rather than one silently shrinking.
    const { fields, valuesByIssueId } = deriveLocalProjectFields([issueWith()]);

    expect(fields.map((f) => f.name)).toEqual(GITHUB_COLUMNS);
    const values = valuesByIssueId.get("issue-1") ?? {};
    // Created and Updated are the only things every Issue has (the title is the table's own
    // column now, not a derived one — see GITHUB_COLUMNS).
    expect(Object.keys(values).sort()).toEqual(["local:created", "local:updated"]);
  });

  it("declares the columns it genuinely cannot fill read-only, each with its own reason", () => {
    const { fields } = deriveLocalProjectFields([]);
    for (const name of ["Estimate", "Iteration", "Start date", "Target date", "Reviewers"]) {
      expect(fields.find((f) => f.name === name)?.readOnlyReason).toBeTruthy();
    }
    // Reviewers is unavailable for a different reason than the board-shaped ones — an issue has
    // no reviewers on any provider — so it must not read as "this Project is local".
    expect(fields.find((f) => f.name === "Reviewers")?.readOnlyReason).not.toBe(
      fields.find((f) => f.name === "Estimate")?.readOnlyReason,
    );
    expect(fields.find((f) => f.name === "Status")?.readOnlyReason).toBeNull();
  });

  it("recognizes GitLab's own `::` scoped labels and SoloW's own seeded `/` labels the same way", () => {
    const a = issueWith({ id: "a", labels: ["status::doing"] });
    const b = issueWith({ id: "b", labels: ["status/todo"] });

    const { fields, valuesByIssueId } = deriveLocalProjectFields([a, b]);

    const status = fields.find((f) => f.name === "Status");
    expect(status?.options.map((o) => o.name).sort()).toEqual(["doing", "todo"]);
    expect(valuesByIssueId.get("a")).toMatchObject({
      "local:status": { type: "single_select", optionId: "status::doing" },
    });
    expect(valuesByIssueId.get("b")).toMatchObject({
      "local:status": { type: "single_select", optionId: "status/todo" },
    });
  });

  it("recognizes prio/priority/pri aliases for Priority, the same set packages/core/priority.ts does", () => {
    const issues = [
      issueWith({ id: "a", labels: ["prio/p1"] }),
      issueWith({ id: "b", labels: ["priority::high"] }),
      issueWith({ id: "c", labels: ["pri-low"] }),
    ];

    const { valuesByIssueId } = deriveLocalProjectFields(issues);

    expect(valuesByIssueId.get("a")?.["local:priority"]).toEqual({
      type: "single_select",
      optionId: "prio/p1",
    });
    expect(valuesByIssueId.get("b")?.["local:priority"]).toEqual({
      type: "single_select",
      optionId: "priority::high",
    });
    expect(valuesByIssueId.get("c")?.["local:priority"]).toEqual({
      type: "single_select",
      optionId: "pri-low",
    });
  });

  it("deduplicates options case-insensitively, the same rule GitLab's own label matching follows", () => {
    const issues = [
      issueWith({ id: "a", labels: ["status::Todo"] }),
      issueWith({ id: "b", labels: ["status::todo"] }),
    ];

    const { fields } = deriveLocalProjectFields(issues);

    expect(fields.find((f) => f.name === "Status")?.options).toHaveLength(1);
  });

  it("does not treat an unrelated label as any scoped field's value", () => {
    const issue = issueWith({ labels: ["bug", "help wanted"] });

    const { valuesByIssueId } = deriveLocalProjectFields([issue]);

    expect(valuesByIssueId.get("issue-1")).not.toHaveProperty("local:status");
    expect(valuesByIssueId.get("issue-1")).not.toHaveProperty("local:priority");
    expect(valuesByIssueId.get("issue-1")).not.toHaveProperty("local:size");
  });

  it("carries assignees, milestone and repository through as values, only when present", () => {
    const withEverything = issueWith({
      id: "full",
      assignees: [{ login: "ada", name: "Ada", avatarUrl: null }],
      milestone: { externalId: "5", title: "v1", startDate: null, dueDate: "2026-09-01" },
      repositoryName: "gate-firmware",
    });
    const withNothing = issueWith({ id: "bare" });

    const { valuesByIssueId } = deriveLocalProjectFields([withEverything, withNothing]);

    expect(valuesByIssueId.get("full")).toMatchObject({
      "local:assignees": { type: "user", users: [{ login: "ada", name: "Ada", avatarUrl: null }] },
      "local:milestone": { type: "text", text: "v1" },
      "local:repository": { type: "text", text: "gate-firmware" },
    });
    expect(valuesByIssueId.get("bare")).not.toHaveProperty("local:assignees");
    expect(valuesByIssueId.get("bare")).not.toHaveProperty("local:milestone");
    expect(valuesByIssueId.get("bare")).not.toHaveProperty("local:repository");
  });

  it("always carries Created and Updated — every Issue has them", () => {
    const { valuesByIssueId } = deriveLocalProjectFields([issueWith()]);

    expect(valuesByIssueId.get("issue-1")).toMatchObject({
      "local:created": { type: "date", date: "2026-01-01T00:00:00.000Z" },
      "local:updated": { type: "date", date: "2026-01-02T00:00:00.000Z" },
    });
  });

  it("reports Closed only once the provider has said open or closed at all", () => {
    const open = issueWith({ id: "open", externalState: "open" });
    const closed = issueWith({ id: "closed", externalState: "closed" });
    const unknown = issueWith({ id: "unknown", externalState: null });

    const { valuesByIssueId } = deriveLocalProjectFields([open, closed, unknown]);

    expect(valuesByIssueId.get("open")?.["local:closed"]).toEqual({ type: "text", text: "No" });
    expect(valuesByIssueId.get("closed")?.["local:closed"]).toEqual({ type: "text", text: "Yes" });
    expect(valuesByIssueId.get("unknown")).not.toHaveProperty("local:closed");
  });

  it("fills Labels and Linked pull requests from the Issue itself", () => {
    const issue = issueWith({
      title: "Cap the upload size",
      labels: ["bug", "status::doing"],
      linkedChangeRequests: [
        {
          externalId: "1",
          number: 12,
          title: "Fix it",
          state: "open",
          url: "u/12",
          mergedAt: null,
        },
        {
          externalId: "2",
          number: 14,
          title: "And again",
          state: "merged",
          url: "u/14",
          mergedAt: "x",
        },
      ],
    });

    const { valuesByIssueId } = deriveLocalProjectFields([issue]);

    expect(valuesByIssueId.get("issue-1")).toMatchObject({
      "local:labels": { type: "text", text: "bug, status::doing" },
      "local:linked_change_requests": { type: "text", text: "#12, #14" },
    });
  });

  it("rolls sub-issues up onto their parent, and names the parent on each child", () => {
    const parent = issueWith({ id: "epic", externalId: "100" });
    const doneChild = issueWith({ id: "a", externalParentId: "100", externalState: "closed" });
    const openChild = issueWith({ id: "b", externalParentId: "100", externalState: "open" });

    const { valuesByIssueId } = deriveLocalProjectFields([parent, doneChild, openChild]);

    expect(valuesByIssueId.get("epic")?.["local:sub_issues"]).toEqual({
      type: "text",
      text: "1/2",
    });
    expect(valuesByIssueId.get("a")?.["local:parent_issue"]).toEqual({
      type: "text",
      text: "#100",
    });
    // A leaf has no roll-up of its own — an empty cell, not "0/0", which would read as an epic
    // whose children are all unfinished.
    expect(valuesByIssueId.get("a")).not.toHaveProperty("local:sub_issues");
  });

  it("never fills Reviewers — the column exists, the value cannot", () => {
    const { valuesByIssueId } = deriveLocalProjectFields([
      issueWith({ assignees: [{ login: "ada", name: "Ada", avatarUrl: null }] }),
    ]);

    expect(valuesByIssueId.get("issue-1")).not.toHaveProperty("local:reviewers");
  });
});
