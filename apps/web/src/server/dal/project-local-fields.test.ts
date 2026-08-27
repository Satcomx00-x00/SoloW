import { describe, expect, it } from "bun:test";
import { deriveLocalProjectFields, type LocalFieldIssue } from "./project-local-fields.js";

/**
 * A local Project's synthesized columns (spec F23, user request 2026-08-28) — the read that
 * replaces the empty `project_field` table FR-21 guarantees a local Project always has.
 */

function issueWith(over: Partial<LocalFieldIssue> = {}): LocalFieldIssue {
  return {
    id: "issue-1",
    labels: [],
    assignees: [],
    milestone: null,
    repositoryName: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    externalState: null,
    ...over,
  };
}

describe("deriveLocalProjectFields", () => {
  it("declares every column even with no Issues, single-selects just carrying no options yet", () => {
    const { fields } = deriveLocalProjectFields([]);

    expect(fields.map((f) => f.name)).toEqual([
      "Assignees",
      "Status",
      "Priority",
      "Size",
      "Milestone",
      "Repository",
      "Created",
      "Updated",
      "Closed",
      "Estimate",
      "Iteration",
      "Start date",
      "Target date",
    ]);
    expect(fields.every((f) => f.readOnly)).toBe(true);
    expect(fields.find((f) => f.name === "Status")?.options).toEqual([]);
  });

  it("declares Estimate/Iteration/Start date/Target date unavailable, with a reason", () => {
    const { fields } = deriveLocalProjectFields([]);
    for (const name of ["Estimate", "Iteration", "Start date", "Target date"]) {
      const field = fields.find((f) => f.name === name);
      expect(field?.readOnlyReason).toBeTruthy();
    }
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
});
