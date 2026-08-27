/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { TaskDto, TaskState } from "@solow/contracts";
import { summariseRowTasks, tasksByIssue } from "./row-tasks";

/**
 * The rule this file exists for: a row's cell shows the state that most **demands a person**, not
 * the newest one. A row whose latest run is `done` while an earlier one waits in `review` still
 * needs a human, and filing it as finished is the one summary a reviewer must never be handed.
 */

const task = (state: TaskState, issueId = "issue-1"): TaskDto =>
  ({
    id: `task-${state}-${issueId}`,
    issueId,
    title: state,
    state,
    repositories: [],
  }) as unknown as TaskDto;

describe("summariseRowTasks", () => {
  it("shows the state that most demands a person, not the most recent", () => {
    // `done` last in the list and still not the answer: the review is what is outstanding.
    expect(summariseRowTasks([task("review"), task("done")])?.state).toBe("review");
    expect(summariseRowTasks([task("done"), task("review")])?.state).toBe("review");
  });

  it("puts review above failed, because only one of them needs a human by definition", () => {
    // A failed run is retried by whoever picks it up; a review is the gate nothing passes without
    // a person (Principle I).
    expect(summariseRowTasks([task("failed"), task("review")])?.state).toBe("review");
  });

  it("prefers a run in flight over a quiet one", () => {
    expect(summariseRowTasks([task("backlog"), task("running")])?.state).toBe("running");
    expect(summariseRowTasks([task("running"), task("done")])?.state).toBe("running");
  });

  it("reports how many there are, so one badge does not read as one task", () => {
    expect(summariseRowTasks([task("done"), task("done"), task("review")])?.total).toBe(3);
  });

  it("answers null for a row with no tasks, which is not a row whose tasks are all done", () => {
    // The cell draws the two differently — nothing at all, versus a `done` badge — and conflating
    // them would say an agent had finished work nobody ever started.
    expect(summariseRowTasks([])).toBeNull();
    expect(summariseRowTasks([task("done")])?.state).toBe("done");
  });
});

describe("tasksByIssue", () => {
  it("groups every task under the issue it runs on", () => {
    const grouped = tasksByIssue([task("running", "a"), task("done", "b"), task("review", "a")]);

    expect(
      grouped
        .get("a")
        ?.map((t) => t.state)
        .sort(),
    ).toEqual(["review", "running"]);
    expect(grouped.get("b")).toHaveLength(1);
    expect(grouped.get("missing")).toBeUndefined();
  });
});
