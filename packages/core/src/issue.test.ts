import { describe, expect, it } from "bun:test";
import type { TaskState } from "@gatecontrol/contracts";
import { deriveIssueStatus } from "./issue.js";

describe("deriveIssueStatus", () => {
  it("returns 'open' when there are no tasks", () => {
    expect(deriveIssueStatus([])).toBe("open");
  });

  it("returns 'in_progress' for any single active state", () => {
    const active: TaskState[] = ["ready", "running", "review", "parked"];
    for (const s of active) {
      expect(deriveIssueStatus([s])).toBe("in_progress");
    }
  });

  it("prefers 'in_progress' when at least one task is active among done/backlog/failed", () => {
    expect(deriveIssueStatus(["done", "running", "backlog"])).toBe("in_progress");
    expect(deriveIssueStatus(["failed", "ready"])).toBe("in_progress");
    expect(deriveIssueStatus(["done", "done", "parked"])).toBe("in_progress");
  });

  it("returns 'resolved' when there are tasks and all are done", () => {
    expect(deriveIssueStatus(["done"])).toBe("resolved");
    expect(deriveIssueStatus(["done", "done", "done"])).toBe("resolved");
  });

  it("returns 'open' for a mix of done and a non-active non-done state", () => {
    expect(deriveIssueStatus(["done", "backlog"])).toBe("open");
    expect(deriveIssueStatus(["done", "failed"])).toBe("open");
    expect(deriveIssueStatus(["failed", "backlog"])).toBe("open");
  });

  it("returns 'open' for non-active non-done states with no done tasks", () => {
    expect(deriveIssueStatus(["backlog"])).toBe("open");
    expect(deriveIssueStatus(["failed"])).toBe("open");
    expect(deriveIssueStatus(["backlog", "failed"])).toBe("open");
  });
});
